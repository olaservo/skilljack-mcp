#!/usr/bin/env node
/**
 * Skill Jack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skill-jack-mcp /path/to/skills    # Skills directory (required)
 *   SKILLS_DIR=/path/to/skills skill-jack-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSkills, generateInstructions, createSkillMap } from "./skill-discovery.js";
import { registerSkillTool, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
} from "./subscriptions.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Get the skills directory from command line args or environment.
 */
function getSkillsDir(): string | null {
  // Check command line argument first
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return path.resolve(args[0]);
  }

  // Fall back to environment variable
  const envDir = process.env.SKILLS_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }

  return null;
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
  instructions: "",
};

/**
 * Discover skills from configured directory.
 * Checks both the directory itself and standard subdirectories.
 */
function discoverSkillsFromDir(skillsDir: string): ReturnType<typeof discoverSkills> {
  const allSkills: ReturnType<typeof discoverSkills> = [];

  // Check if the directory itself contains skills
  const directSkills = discoverSkills(skillsDir);
  allSkills.push(...directSkills);

  // Also check standard subdirectories
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
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  const skillsDir = getSkillsDir();

  if (!skillsDir) {
    console.error("No skills directory configured.");
    console.error("Usage: skill-jack-mcp /path/to/skills");
    console.error("   or: SKILLS_DIR=/path/to/skills skill-jack-mcp");
    process.exit(1);
  }

  console.error(`Skills directory: ${skillsDir}`);

  // Discover skills at startup
  const skills = discoverSkillsFromDir(skillsDir);
  skillState.skillMap = createSkillMap(skills);
  skillState.instructions = generateInstructions(skills);
  console.error(`Discovered ${skills.length} skill(s)`);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "skill-jack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
      },
      instructions: skillState.instructions,
    }
  );

  // Register tools and resources
  registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skill Jack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
