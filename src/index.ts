#!/usr/bin/env node
/**
 * Skill Jack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Now with MCP Roots support for dynamic workspace skill discovery.
 *
 * Usage:
 *   skill-jack-mcp                    # Uses roots from client
 *   skill-jack-mcp /path/to/skills    # Skills directory
 *   SKILLS_DIR=/path/to/skills skill-jack-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSkills, generateInstructions, createSkillMap } from "./skill-discovery.js";
import { registerSkillTool, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { syncSkills, SKILL_SUBDIRS } from "./roots-handler.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
  refreshSubscriptions,
} from "./subscriptions.js";

/**
 * Get the skills directory from command line args or environment.
 * This directory is scanned at startup to populate server instructions.
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
 * Shared state for dynamic skill management.
 * Tools and resources reference this state, allowing updates when roots change.
 */
const skillState: SkillState = {
  skillMap: new Map(),
  instructions: "",
};

/**
 * Discover skills synchronously from configured directory.
 * Checks both the directory itself and SKILL_SUBDIRS subdirectories.
 * Used at startup to populate initial instructions before roots are available.
 */
function discoverSkillsFromDir(skillsDir: string | null): ReturnType<typeof discoverSkills> {
  if (!skillsDir) {
    return [];
  }

  const allSkills: ReturnType<typeof discoverSkills> = [];

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
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  const skillsDir = getSkillsDir();

  // Log startup mode
  if (skillsDir) {
    console.error(`Skills directory: ${skillsDir}`);
  } else {
    console.error("No skills directory configured (will use roots only)");
  }

  // Discover skills synchronously at startup for initial instructions
  // This ensures the initialize response includes skills before roots are available
  const initialSkills = discoverSkillsFromDir(skillsDir);
  skillState.skillMap = createSkillMap(initialSkills);
  skillState.instructions = generateInstructions(initialSkills);
  console.error(`Initial skills discovered: ${initialSkills.length}`);

  // Create the MCP server with pre-discovered skills in instructions
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
      // Include skills discovered from configured directory
      instructions: skillState.instructions,
    }
  );

  // Register tools and resources that reference the shared skillState
  // These will use the current skillMap, which gets updated dynamically
  registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Set up post-initialization handler for roots discovery
  // Pattern from .claude/skills/mcp-server-ts/snippets/server/index.ts
  server.server.oninitialized = async () => {
    // Delay to ensure notifications/initialized handler finishes
    // (per MCP reference implementation)
    setTimeout(() => {
      syncSkills(server, skillsDir, (newSkillMap, newInstructions) => {
        // Update shared state
        skillState.skillMap = newSkillMap;
        skillState.instructions = newInstructions;

        // Refresh subscriptions with new skill paths
        const sendNotification = (uri: string) => {
          server.server.notification({
            method: "notifications/resources/updated",
            params: { uri },
          });
        };
        refreshSubscriptions(subscriptionManager, skillState, sendNotification);

        const skillNames = Array.from(newSkillMap.keys());
        console.error(
          `Skills updated: ${skillNames.join(", ") || "none"}`
        );
      });
    }, 350);
  };

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skill Jack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
