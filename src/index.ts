#!/usr/bin/env node
/**
 * Skill Jack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 *
 * Usage:
 *   skill-jack-mcp /path/to/skills
 *   SKILLS_DIR=/path/to/skills skill-jack-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import {
  discoverSkills,
  generateInstructions,
  createSkillMap,
} from "./skill-discovery.js";
import { registerSkillTool } from "./skill-tool.js";

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

async function main() {
  const skillsDir = getSkillsDir();

  if (!skillsDir) {
    console.error("Usage: skill-jack-mcp <skills-directory>");
    console.error("   or: SKILLS_DIR=/path/to/skills skill-jack-mcp");
    process.exit(1);
  }

  console.error(`Discovering skills from: ${skillsDir}`);

  // Discover skills and generate instructions
  const skills = discoverSkills(skillsDir);
  console.error(`Found ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ") || "none"}`);

  const instructions = generateInstructions(skills);
  const skillMap = createSkillMap(skills);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "skill-jack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions,
    }
  );

  // Register the skill tool
  registerSkillTool(server, skillMap);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skill Jack ready. I know kung fu.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
