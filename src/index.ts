#!/usr/bin/env node
/**
 * Skilljack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skilljack-mcp /path/to/skills [/path2 ...]   # One or more directories
 *   SKILLS_DIR=/path/to/skills skilljack-mcp    # Single directory via env
 *   SKILLS_DIR=/path1,/path2 skilljack-mcp      # Multiple (comma-separated)
 */

import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import chokidar from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSkills, createSkillMap } from "./skill-discovery.js";
import { registerSkillTool, getToolDescription, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts, refreshPrompts, PromptRegistry } from "./skill-prompts.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
  refreshSubscriptions,
  SubscriptionManager,
} from "./subscriptions.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Separator for multiple paths in SKILLS_DIR environment variable.
 * Comma works cross-platform (not valid in file paths on any OS).
 */
const PATH_LIST_SEPARATOR = ",";

/**
 * Get the skills directories from command line args and/or environment.
 * Returns deduplicated, resolved paths.
 */
function getSkillsDirs(): string[] {
  const dirs: string[] = [];

  // Collect all non-flag command-line arguments (comma-separated supported)
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      const paths = arg
        .split(PATH_LIST_SEPARATOR)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => path.resolve(p));
      dirs.push(...paths);
    }
  }

  // Also check environment variable (comma-separated supported)
  const envDir = process.env.SKILLS_DIR;
  if (envDir) {
    const envPaths = envDir
      .split(PATH_LIST_SEPARATOR)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => path.resolve(p));
    dirs.push(...envPaths);
  }

  // Deduplicate by resolved path
  return [...new Set(dirs)];
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
};

/**
 * Discover skills from multiple configured directories.
 * Each directory is checked along with its standard subdirectories.
 * Handles duplicate skill names by keeping first occurrence.
 */
function discoverSkillsFromDirs(skillsDirs: string[]): ReturnType<typeof discoverSkills> {
  const allSkills: ReturnType<typeof discoverSkills> = [];
  const seenNames = new Map<string, string>(); // name -> source directory

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) {
      console.error(`Warning: Skills directory not found: ${skillsDir}`);
      continue;
    }

    console.error(`Scanning skills directory: ${skillsDir}`);

    // Check if the directory itself contains skills
    const dirSkills = discoverSkills(skillsDir);

    // Also check standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      const subPath = path.join(skillsDir, subdir);
      if (fs.existsSync(subPath)) {
        dirSkills.push(...discoverSkills(subPath));
      }
    }

    // Add skills, checking for duplicates
    for (const skill of dirSkills) {
      if (seenNames.has(skill.name)) {
        console.error(
          `Warning: Duplicate skill "${skill.name}" found in ${path.dirname(skill.path)} ` +
            `(already loaded from ${seenNames.get(skill.name)})`
        );
        continue; // Skip duplicate
      }
      seenNames.set(skill.name, path.dirname(skill.path));
      allSkills.push(skill);
    }
  }

  return allSkills;
}

/**
 * Debounce delay for skill directory changes (ms).
 * Multiple rapid changes are coalesced into one refresh.
 */
const SKILL_REFRESH_DEBOUNCE_MS = 500;

/**
 * Refresh skills and notify clients of changes.
 * Called when skill files change on disk.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing resource subscriptions
 */
function refreshSkills(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  console.error("Refreshing skills...");

  // Re-discover all skills
  const skills = discoverSkillsFromDirs(skillsDirs);
  const oldCount = skillState.skillMap.size;

  // Update shared state
  skillState.skillMap = createSkillMap(skills);

  console.error(`Skills refreshed: ${oldCount} -> ${skills.length} skill(s)`);

  // Update the skill tool description with new instructions
  skillTool.update({
    description: getToolDescription(skillState),
  });

  // Refresh prompts to match new skill state
  refreshPrompts(server, skillState, promptRegistry);

  // Refresh resource subscriptions to match new skill state
  refreshSubscriptions(subscriptionManager, skillState, (uri) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  });

  // Notify clients that tools have changed
  // This prompts clients to call tools/list again
  server.sendToolListChanged();

  // Also notify that resources have changed
  server.sendResourceListChanged();
}

/**
 * Set up file watchers on skill directories to detect changes.
 * Watches for SKILL.md additions, modifications, and deletions.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing subscriptions
 */
function watchSkillDirectories(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  let refreshTimeout: NodeJS.Timeout | null = null;

  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      refreshSkills(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);
    }, SKILL_REFRESH_DEBOUNCE_MS);
  };

  // Build list of paths to watch
  const watchPaths: string[] = [];
  for (const dir of skillsDirs) {
    if (fs.existsSync(dir)) {
      watchPaths.push(dir);
      // Also watch standard subdirectories
      for (const subdir of SKILL_SUBDIRS) {
        const subPath = path.join(dir, subdir);
        if (fs.existsSync(subPath)) {
          watchPaths.push(subPath);
        }
      }
    }
  }

  if (watchPaths.length === 0) {
    console.error("No skill directories to watch");
    return;
  }

  console.error(`Watching for skill changes in: ${watchPaths.join(", ")}`);

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 2, // Watch skill subdirectories but not too deep
    ignored: ["**/node_modules/**", "**/.git/**"],
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  // Watch for SKILL.md changes specifically
  watcher.on("add", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill added: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("change", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill modified: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlink", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill removed: ${filePath}`);
      debouncedRefresh();
    }
  });

  // Also watch for directory additions (new skill folders)
  watcher.on("addDir", (dirPath) => {
    // Check if this might be a new skill directory
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const skillMdPathLower = path.join(dirPath, "skill.md");
    if (fs.existsSync(skillMdPath) || fs.existsSync(skillMdPathLower)) {
      console.error(`Skill directory added: ${dirPath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlinkDir", (dirPath) => {
    // A skill directory was removed
    console.error(`Directory removed: ${dirPath}`);
    debouncedRefresh();
  });
}

/**
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  const skillsDirs = getSkillsDirs();

  if (skillsDirs.length === 0) {
    console.error("No skills directory configured.");
    console.error("Usage: skilljack-mcp /path/to/skills [/path/to/more/skills ...]");
    console.error("   or: SKILLS_DIR=/path/to/skills skilljack-mcp");
    console.error("   or: SKILLS_DIR=/path1,/path2 skilljack-mcp");
    process.exit(1);
  }

  console.error(`Skills directories: ${skillsDirs.join(", ")}`);

  // Discover skills at startup
  const skills = discoverSkillsFromDirs(skillsDirs);
  skillState.skillMap = createSkillMap(skills);
  console.error(`Discovered ${skills.length} skill(s)`);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "skilljack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    }
  );

  // Register tools, resources, and prompts
  const skillTool = registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);
  const promptRegistry = registerSkillPrompts(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Set up file watchers for skill directory changes
  watchSkillDirectories(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skilljack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
