/**
 * MCP prompt registration for skill loading.
 *
 * Provides two patterns for loading skills:
 * 1. /skill prompt - Single prompt with name argument + auto-completion
 * 2. Per-skill prompts - Dynamic prompts for each skill (e.g., /mcp-server-ts)
 */

import { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { loadSkillContent, generateInstructions } from "./skill-discovery.js";
import { SkillState } from "./skill-tool.js";

/**
 * Track all registered prompts for dynamic updates.
 */
export interface PromptRegistry {
  skillPrompt: RegisteredPrompt; // The /skill prompt
  perSkillPrompts: Map<string, RegisteredPrompt>; // skill-name -> prompt
}

/**
 * Auto-completion for /skill prompt name argument.
 * Returns skill names that start with the given value (case-insensitive).
 */
function getSkillNameCompletions(value: string, skillState: SkillState): string[] {
  const names = Array.from(skillState.skillMap.keys());
  return names.filter((name) => name.toLowerCase().startsWith(value.toLowerCase()));
}

/**
 * Generate the description for the /skill prompt.
 * Includes available skills list for discoverability.
 */
export function getPromptDescription(skillState: SkillState): string {
  const skills = Array.from(skillState.skillMap.values());
  const usage = "Load a skill by name with auto-completion.\n\n";
  return usage + generateInstructions(skills);
}

/**
 * Register skill prompts with the MCP server.
 *
 * Creates:
 * 1. /skill prompt with name argument + auto-completion
 * 2. Per-skill prompts for each discovered skill
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 * @returns Registry for tracking and updating prompts
 */
export function registerSkillPrompts(
  server: McpServer,
  skillState: SkillState
): PromptRegistry {
  // 1. Register /skill prompt with argument + auto-completion
  const skillPrompt = server.registerPrompt(
    "skill",
    {
      title: "Load Skill",
      description: getPromptDescription(skillState),
      argsSchema: {
        name: completable(
          z.string().describe("Skill name"),
          (value) => getSkillNameCompletions(value, skillState)
        ),
      },
    },
    async ({ name }) => {
      const skill = skillState.skillMap.get(name);

      if (!skill) {
        const availableSkills = Array.from(skillState.skillMap.keys()).join(", ");
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Skill "${name}" not found. Available skills: ${availableSkills || "none"}`,
              },
            },
          ],
        };
      }

      try {
        const content = loadSkillContent(skill.path);
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "resource",
                resource: {
                  uri: `skill://${name}`,
                  mimeType: "text/markdown",
                  text: content,
                },
                annotations: {
                  audience: ["assistant"],
                  priority: 1.0,
                },
              },
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Failed to load skill "${name}": ${message}`,
              },
            },
          ],
        };
      }
    }
  );

  // 2. Register per-skill prompts (no arguments needed)
  // Returns embedded resource with skill:// URI (MCP-idiomatic)
  const perSkillPrompts = new Map<string, RegisteredPrompt>();

  for (const [name, skill] of skillState.skillMap) {
    // Capture skill info in closure for this specific prompt
    const skillPath = skill.path;
    const skillName = name;
    const prompt = server.registerPrompt(
      name,
      {
        title: skill.name,
        description: skill.description,
        // No argsSchema - direct invocation
      },
      async () => {
        try {
          const content = loadSkillContent(skillPath);
          return {
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "resource" as const,
                  resource: {
                    uri: `skill://${skillName}`,
                    mimeType: "text/markdown",
                    text: content,
                  },
                  annotations: {
                    audience: ["assistant" as const],
                    priority: 1.0,
                  },
                },
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: `Failed to load skill "${skillName}": ${message}`,
                },
              },
            ],
          };
        }
      }
    );
    perSkillPrompts.set(name, prompt);
  }

  return { skillPrompt, perSkillPrompts };
}

/**
 * Refresh prompts when skills change.
 *
 * Updates:
 * - /skill prompt description with new skill list
 * - Disables prompts for removed skills
 * - Adds prompts for new skills
 * - Updates descriptions for modified skills
 *
 * @param server - The McpServer instance
 * @param skillState - Updated skill state
 * @param registry - Prompt registry to update
 */
export function refreshPrompts(
  server: McpServer,
  skillState: SkillState,
  registry: PromptRegistry
): void {
  // Update /skill prompt description with new skill list
  registry.skillPrompt.update({
    description: getPromptDescription(skillState),
  });

  // Disable removed skill prompts
  for (const [name, prompt] of registry.perSkillPrompts) {
    if (!skillState.skillMap.has(name)) {
      prompt.update({ enabled: false });
      registry.perSkillPrompts.delete(name);
    }
  }

  // Add/update per-skill prompts
  for (const [name, skill] of skillState.skillMap) {
    if (registry.perSkillPrompts.has(name)) {
      // Update existing prompt description
      registry.perSkillPrompts.get(name)!.update({
        description: skill.description,
      });
    } else {
      // Register new skill prompt with embedded resource
      const skillPath = skill.path;
      const skillName = name;
      const prompt = server.registerPrompt(
        name,
        {
          title: skill.name,
          description: skill.description,
        },
        async () => {
          try {
            const content = loadSkillContent(skillPath);
            return {
              messages: [
                {
                  role: "user" as const,
                  content: {
                    type: "resource" as const,
                    resource: {
                      uri: `skill://${skillName}`,
                      mimeType: "text/markdown",
                      text: content,
                    },
                    annotations: {
                      audience: ["assistant" as const],
                      priority: 1.0,
                    },
                  },
                },
              ],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              messages: [
                {
                  role: "user" as const,
                  content: {
                    type: "text" as const,
                    text: `Failed to load skill "${skillName}": ${message}`,
                  },
                },
              ],
            };
          }
        }
      );
      registry.perSkillPrompts.set(name, prompt);
    }
  }

  // Notify clients that prompts have changed
  server.sendPromptListChanged();
}
