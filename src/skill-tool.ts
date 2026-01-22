/**
 * MCP tool registration for skill-related tools.
 *
 * - skill: Load and activate a skill by name (returns SKILL.md content)
 * - skill-resource: Read files within a skill directory (scripts/, references/, assets/, etc.)
 *
 * Tools reference a shared SkillState object to support dynamic skill updates
 * when MCP roots change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SkillMetadata, loadSkillContent, generateInstructions } from "./skill-discovery.js";

/**
 * Shared state for dynamic skill management.
 * Tools reference this state object, allowing updates when roots change.
 */
export interface SkillState {
  skillMap: Map<string, SkillMetadata>;
}

/**
 * Input schema for the skill tool.
 */
const SkillSchema = z.object({
  name: z.string().describe("Skill name from <available_skills>"),
});

/**
 * Register the "skill" tool with the MCP server.
 *
 * The tool description includes the full skill discovery instructions (same format as
 * server instructions) to enable dynamic updates via tools/listChanged notifications.
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 * @returns The registered tool, which can be updated when skills change
 */
/**
 * Generate the full tool description including usage guidance and skill list.
 * Exported so index.ts can use it when refreshing skills.
 */
export function getToolDescription(skillState: SkillState): string {
  const usage =
    "Load a skill's full instructions. Returns the complete SKILL.md content " +
    "with step-by-step guidance, examples, and file references to follow.\n\n" +
    "IMPORTANT: When a skill is relevant to the user's task, you must invoke this tool " +
    "IMMEDIATELY as your first action. NEVER just announce or mention a skill without " +
    "actually calling this tool. This is a BLOCKING REQUIREMENT: invoke this tool BEFORE " +
    "generating any other response about the task.\n\n";

  const skills = Array.from(skillState.skillMap.values());
  return usage + generateInstructions(skills);
}

export function registerSkillTool(
  server: McpServer,
  skillState: SkillState
): RegisteredTool {
  const skillTool = server.registerTool(
    "skill",
    {
      title: "Activate Skill",
      description: getToolDescription(skillState),
      inputSchema: SkillSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { name } = SkillSchema.parse(args);
      const skill = skillState.skillMap.get(name);

      if (!skill) {
        const availableSkills = Array.from(skillState.skillMap.keys()).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Skill "${name}" not found. Available skills: ${availableSkills || "none"}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const content = loadSkillContent(skill.path);
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to load skill "${name}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register the skill-resource tool
  registerSkillResourceTool(server, skillState);

  return skillTool;
}

/**
 * Input schema for the skill-resource tool.
 *
 * Per the Agent Skills spec, file references use relative paths from the skill root.
 * Common directories: scripts/, references/, assets/
 */
const SkillResourceSchema = z.object({
  skill: z.string().describe("Skill name"),
  path: z
    .string()
    .describe("Relative path to file or directory. Examples: 'snippets/tool.ts' (single file), 'templates' (all files in directory), '' (list available files)."),
});

// Security constants (exported for reuse in skill-resources.ts)
const DEFAULT_MAX_FILE_SIZE_MB = 1;
const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || "", 10) || DEFAULT_MAX_FILE_SIZE_MB;
export const MAX_FILE_SIZE = maxFileSizeMB * 1024 * 1024; // Configurable via MAX_FILE_SIZE_MB env var
export const MAX_DIRECTORY_DEPTH = 10; // Prevent deeply nested traversal

/**
 * Check if a path is within the allowed base directory.
 * Uses fs.realpathSync to resolve symlinks and prevent symlink escape attacks.
 */
export function isPathWithinBase(targetPath: string, baseDir: string): boolean {
  try {
    // Resolve symlinks to get the real paths
    const realBase = fs.realpathSync(baseDir);
    const realTarget = fs.realpathSync(targetPath);

    const normalizedBase = realBase + path.sep;
    return realTarget === realBase || realTarget.startsWith(normalizedBase);
  } catch {
    // If realpathSync fails (e.g., file doesn't exist), fall back to resolve check
    // This is safe because we'll get an error when trying to read anyway
    const normalizedBase = path.resolve(baseDir) + path.sep;
    const normalizedPath = path.resolve(targetPath);
    return normalizedPath.startsWith(normalizedBase);
  }
}

/**
 * List files in a skill directory for discovery.
 * Limits recursion depth to prevent DoS from deeply nested directories.
 */
export function listSkillFiles(skillDir: string, subPath: string = "", depth: number = 0): string[] {
  // Prevent excessive recursion
  if (depth > MAX_DIRECTORY_DEPTH) {
    return [];
  }

  const files: string[] = [];
  const dirPath = path.join(skillDir, subPath);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return files;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(subPath, entry.name);

    // Skip symlinks to prevent escape and infinite loops
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        files.push(...listSkillFiles(skillDir, relativePath, depth + 1));
      }
    } else {
      // Skip SKILL.md (use skill tool for that) and common non-resource files
      if (entry.name !== "SKILL.md" && entry.name !== "skill.md") {
        files.push(relativePath.replace(/\\/g, "/"));
      }
    }
  }

  return files;
}

/**
 * Register the "skill-resource" tool with the MCP server.
 *
 * This tool provides access to files within a skill's directory structure,
 * following the Agent Skills spec for progressive disclosure of resources.
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 */
function registerSkillResourceTool(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerTool(
    "skill-resource",
    {
      title: "Read Skill File",
      description:
        "Read files referenced by skill instructions (scripts, snippets, templates). " +
        "Use when skill instructions mention specific files to read or copy. " +
        "Pass a directory path (e.g., 'templates') to read all files in that directory at once.",
      inputSchema: SkillResourceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { skill: skillName, path: resourcePath } = SkillResourceSchema.parse(args);
      const skill = skillState.skillMap.get(skillName);

      if (!skill) {
        const availableSkills = Array.from(skillState.skillMap.keys()).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Skill "${skillName}" not found. Available skills: ${availableSkills || "none"}`,
            },
          ],
          isError: true,
        };
      }

      // Get the skill directory (parent of SKILL.md)
      const skillDir = path.dirname(skill.path);

      // If path is empty, list available files
      if (!resourcePath || resourcePath.trim() === "") {
        const files = listSkillFiles(skillDir);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No resource files found in skill "${skillName}". The skill only contains SKILL.md.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Available resources in skill "${skillName}":\n\n${files.map((f) => `- ${f}`).join("\n")}`,
            },
          ],
        };
      }

      // Resolve the full path and validate it's within the skill directory
      const fullPath = path.resolve(skillDir, resourcePath);

      if (!isPathWithinBase(fullPath, skillDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid path: "${resourcePath}" is outside the skill directory. Use relative paths like "scripts/example.py" or "references/guide.md".`,
            },
          ],
          isError: true,
        };
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        const files = listSkillFiles(skillDir);
        const suggestions = files.slice(0, 10).join("\n- ");
        return {
          content: [
            {
              type: "text",
              text: `Resource "${resourcePath}" not found in skill "${skillName}".\n\nAvailable files:\n- ${suggestions}${files.length > 10 ? `\n... and ${files.length - 10} more` : ""}`,
            },
          ],
          isError: true,
        };
      }

      // Check file stats
      const stat = fs.statSync(fullPath);

      // Reject symlinks that point outside (defense in depth)
      if (stat.isSymbolicLink()) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot read symlink "${resourcePath}". Only regular files within the skill directory are accessible.`,
            },
          ],
          isError: true,
        };
      }

      // Handle directories - return all file contents
      if (stat.isDirectory()) {
        const files = listSkillFiles(skillDir, resourcePath);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Directory "${resourcePath}" is empty or contains no readable files.`,
              },
            ],
          };
        }

        // Read all files and return as multiple content items
        const contents: Array<{ type: "text"; text: string }> = [];
        for (const file of files) {
          const filePath = path.join(skillDir, file);
          try {
            const fileStat = fs.statSync(filePath);
            if (fileStat.size > MAX_FILE_SIZE) {
              contents.push({
                type: "text",
                text: `--- ${file} ---\n[File too large: ${(fileStat.size / 1024 / 1024).toFixed(2)}MB]`,
              });
            } else {
              const fileContent = fs.readFileSync(filePath, "utf-8");
              contents.push({
                type: "text",
                text: `--- ${file} ---\n${fileContent}`,
              });
            }
          } catch (error) {
            contents.push({
              type: "text",
              text: `--- ${file} ---\n[Error reading file: ${error instanceof Error ? error.message : "unknown error"}]`,
            });
          }
        }

        return { content: contents };
      }

      // Check file size to prevent memory exhaustion
      if (stat.size > MAX_FILE_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
        return {
          content: [
            {
              type: "text",
              text: `File "${resourcePath}" is too large (${sizeMB}MB). Maximum allowed size is ${maxMB}MB.`,
            },
          ],
          isError: true,
        };
      }

      // Final symlink check using realpath (defense in depth)
      if (!isPathWithinBase(fullPath, skillDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: "${resourcePath}" resolves to a location outside the skill directory.`,
            },
          ],
          isError: true,
        };
      }

      // Read and return the file content
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to read resource "${resourcePath}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
