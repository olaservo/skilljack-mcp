/**
 * MCP Roots handler for dynamic skill discovery.
 *
 * Requests roots from the client, scans for skills in each root,
 * and handles root change notifications.
 *
 * Pattern adapted from:
 * - .claude/skills/mcp-server-ts/snippets/server/index.ts (oninitialized, syncRoots)
 * - .claude/skills/mcp-client-ts/snippets/handlers/roots.ts (URI conversion)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverSkills,
  SkillMetadata,
  generateInstructions,
  createSkillMap,
} from "./skill-discovery.js";

/**
 * Skill discovery locations within each root.
 */
export const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Convert a file:// URI to a filesystem path.
 * Adapted from mcp-client-ts roots.ts pathToRoot() (reverse direction).
 */
function uriToPath(uri: string): string {
  return fileURLToPath(new URL(uri));
}

/**
 * Discover skills from all roots provided by the client.
 *
 * Scans each root for skill directories (.claude/skills/, skills/)
 * and handles naming conflicts by prefixing with root name.
 *
 * @param roots - Array of Root objects from client's roots/list response
 * @returns Object containing discovered skills
 */
export function discoverSkillsFromRoots(
  roots: Array<{ uri: string; name?: string }>
): { skills: SkillMetadata[]; rootSources: Map<string, string> } {
  const allSkills: SkillMetadata[] = [];
  const rootSources = new Map<string, string>(); // skill path -> root name
  const nameCount = new Map<string, number>(); // track duplicates

  for (const root of roots) {
    let rootPath: string;
    try {
      rootPath = uriToPath(root.uri);
    } catch (error) {
      console.error(`Failed to parse root URI "${root.uri}":`, error);
      continue;
    }

    const rootName = root.name || path.basename(rootPath);

    for (const subdir of SKILL_SUBDIRS) {
      const skillsDir = path.join(rootPath, subdir);

      if (fs.existsSync(skillsDir)) {
        try {
          const skills = discoverSkills(skillsDir);

          for (const skill of skills) {
            // Track which root this skill came from
            rootSources.set(skill.path, rootName);

            // Count occurrences of each name
            const count = (nameCount.get(skill.name) || 0) + 1;
            nameCount.set(skill.name, count);

            allSkills.push(skill);
          }
        } catch (error) {
          console.error(`Failed to discover skills in "${skillsDir}":`, error);
        }
      }
    }
  }

  // Handle naming conflicts by prefixing duplicates with root name
  for (const skill of allSkills) {
    if (nameCount.get(skill.name)! > 1) {
      const rootName = rootSources.get(skill.path)!;
      skill.name = `${rootName}:${skill.name}`;
    }
  }

  return { skills: allSkills, rootSources };
}

/**
 * Callback type for when skills are updated.
 */
export type SkillsChangedCallback = (
  skillMap: Map<string, SkillMetadata>,
  instructions: string
) => void;

/**
 * Discover skills from a directory, checking both the directory itself
 * and SKILL_SUBDIRS subdirectories.
 */
function discoverSkillsFromDirectory(skillsDir: string): SkillMetadata[] {
  const allSkills: SkillMetadata[] = [];

  // Check if the directory itself contains skills
  const directSkills = discoverSkills(skillsDir);
  allSkills.push(...directSkills);

  // Also check SKILL_SUBDIRS subdirectories
  for (const subdir of SKILL_SUBDIRS) {
    const subPath = path.join(skillsDir, subdir);
    if (fs.existsSync(subPath)) {
      const subdirSkills = discoverSkills(subPath);
      allSkills.push(...subdirSkills);
    }
  }

  return allSkills;
}

/**
 * Sync skills from roots or configured skills directory.
 *
 * Pattern from mcp-server-ts snippets/server/index.ts:
 * - Check client capabilities
 * - Request roots if supported
 * - Use skills directory if not
 *
 * @param server - The McpServer instance
 * @param skillsDir - Optional skills directory if client doesn't support roots
 * @param onSkillsChanged - Callback when skills are updated
 */
export async function syncSkills(
  server: McpServer,
  skillsDir: string | null,
  onSkillsChanged: SkillsChangedCallback
): Promise<void> {
  const capabilities = server.server.getClientCapabilities();
  const allSkills: SkillMetadata[] = [];
  const seenNames = new Set<string>();

  // Always discover from configured skills directory first
  if (skillsDir) {
    const dirSkills = discoverSkillsFromDirectory(skillsDir);
    console.error(`Discovered ${dirSkills.length} skill(s) from skills directory`);
    for (const skill of dirSkills) {
      if (!seenNames.has(skill.name)) {
        seenNames.add(skill.name);
        allSkills.push(skill);
      }
    }
  }

  // Also discover from roots if client supports them
  if (capabilities?.roots) {
    console.error("Client supports roots, requesting workspace roots...");

    try {
      const { roots } = await server.server.listRoots();
      console.error(`Received ${roots.length} root(s) from client`);

      const { skills: rootSkills } = discoverSkillsFromRoots(roots);
      console.error(`Discovered ${rootSkills.length} skill(s) from roots`);

      // Add roots skills, skipping duplicates (skillsDir takes precedence)
      for (const skill of rootSkills) {
        if (!seenNames.has(skill.name)) {
          seenNames.add(skill.name);
          allSkills.push(skill);
        }
      }

      // Listen for roots changes if client supports listChanged
      if (capabilities.roots.listChanged) {
        setupRootsChangeHandler(server, skillsDir, onSkillsChanged);
      }
    } catch (error) {
      console.error("Failed to get roots from client:", error);
    }
  } else {
    console.error("Client does not support roots");
  }

  console.error(`Total skills available: ${allSkills.length}`);
  const skillMap = createSkillMap(allSkills);
  const instructions = generateInstructions(allSkills);
  onSkillsChanged(skillMap, instructions);
}

/**
 * Set up handler for roots/list_changed notifications.
 */
function setupRootsChangeHandler(
  server: McpServer,
  skillsDir: string | null,
  onSkillsChanged: SkillsChangedCallback
): void {
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      console.error("Roots changed notification received, re-discovering skills...");

      try {
        const allSkills: SkillMetadata[] = [];
        const seenNames = new Set<string>();

        // Always include skills from configured directory first
        if (skillsDir) {
          const dirSkills = discoverSkillsFromDirectory(skillsDir);
          for (const skill of dirSkills) {
            if (!seenNames.has(skill.name)) {
              seenNames.add(skill.name);
              allSkills.push(skill);
            }
          }
        }

        // Add skills from roots
        const { roots } = await server.server.listRoots();
        const { skills: rootSkills } = discoverSkillsFromRoots(roots);

        console.error(`Re-discovered ${rootSkills.length} skill(s) from updated roots`);

        for (const skill of rootSkills) {
          if (!seenNames.has(skill.name)) {
            seenNames.add(skill.name);
            allSkills.push(skill);
          }
        }

        console.error(`Total skills available: ${allSkills.length}`);
        const skillMap = createSkillMap(allSkills);
        const instructions = generateInstructions(allSkills);

        onSkillsChanged(skillMap, instructions);

        // Notify client that resources have changed
        await server.server.notification({
          method: "notifications/resources/list_changed",
        });
      } catch (error) {
        console.error("Failed to re-discover skills after roots change:", error);
      }
    }
  );
}
