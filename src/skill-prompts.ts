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
import {
  loadSkillContent,
  generateInstructions,
  getUserInvocableSkills,
  buildSkillResourceUri,
} from "./skill-discovery.js";
import { SkillState } from "./skill-tool.js";

/**
 * Track all registered prompts for dynamic updates.
 */
export interface PromptRegistry {
  skillPrompt: RegisteredPrompt; // The /skill prompt
  perSkillPrompts: Map<string, RegisteredPrompt>; // skill-name -> prompt (active)
  disabledPrompts: Map<string, RegisteredPrompt>; // skill-name -> prompt (disabled, can be re-enabled)
  skillsPrompt: RegisteredPrompt; // The /skills prompt (opens skill-display UI)
  skillConfigPrompt: RegisteredPrompt; // The /skill-config prompt (opens config UI)
}

/**
 * Auto-completion for /skill prompt name argument.
 * Returns skill names that start with the given value (case-insensitive).
 */
function getSkillNameCompletions(value: string, skillState: SkillState): string[] {
  const names = Array.from(skillState.skillMap.keys());
  return names.filter((name) => name.toLowerCase().includes(value.toLowerCase()));
}

/**
 * Generate the description for the /skill prompt.
 * Includes available skills list for discoverability.
 * Only includes user-invocable skills (excludes user-invocable: false).
 */
export function getPromptDescription(skillState: SkillState): string {
  const allSkills = Array.from(skillState.skillMap.values());
  const userInvocableSkills = getUserInvocableSkills(allSkills);
  const usage = "Load a skill by name with auto-completion.\n\n";
  return usage + generateInstructions(userInvocableSkills);
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
                  uri: buildSkillResourceUri(skill, "SKILL.md"),
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

  // 2. Register /skills prompt (opens skill-display UI)
  const skillsPrompt = server.registerPrompt(
    "skills",
    {
      title: "View Skills",
      description: "Open the skills list UI to view all available skills and manage their invocation settings.",
    },
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Please open the skills display UI using the skill-display tool so I can view and manage my skills.",
            },
          },
        ],
      };
    }
  );

  // 3. Register /skill-config prompt (opens config UI)
  const skillConfigPrompt = server.registerPrompt(
    "skill-config",
    {
      title: "Configure Skills",
      description: "Open the skills configuration UI to manage skill directories and GitHub sources.",
    },
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Please open the skills configuration UI using the skill-config tool so I can manage my skill directories.",
            },
          },
        ],
      };
    }
  );

  // 4. Register per-skill prompts (no arguments needed)
  // Returns embedded resource with skill:// URI (MCP-idiomatic)
  // Only register prompts for user-invocable skills (excludes user-invocable: false)
  const perSkillPrompts = new Map<string, RegisteredPrompt>();
  const userInvocableSkills = getUserInvocableSkills(Array.from(skillState.skillMap.values()));

  for (const skill of userInvocableSkills) {
    const name = skill.name;
    // Capture skill info in closure for this specific prompt
    const skillPath = skill.path;
    const skillName = name;
    const skillUri = buildSkillResourceUri(skill, "SKILL.md");
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
                    uri: skillUri,
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

  return { skillPrompt, perSkillPrompts, disabledPrompts: new Map(), skillsPrompt, skillConfigPrompt };
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

  // Get current user-invocable skills
  const userInvocableSkills = getUserInvocableSkills(Array.from(skillState.skillMap.values()));
  const userInvocableNames = new Set(userInvocableSkills.map((s) => s.name));

  // Disable prompts for removed skills or skills no longer user-invocable
  for (const [name, prompt] of registry.perSkillPrompts) {
    if (!userInvocableNames.has(name)) {
      prompt.update({ enabled: false });
      // Move to disabled map so we can re-enable later if needed
      registry.disabledPrompts.set(name, prompt);
      registry.perSkillPrompts.delete(name);
    }
  }

  // Add/update per-skill prompts for user-invocable skills only
  for (const skill of userInvocableSkills) {
    const name = skill.name;
    if (registry.perSkillPrompts.has(name)) {
      // Update existing prompt description
      registry.perSkillPrompts.get(name)!.update({
        description: skill.description,
      });
    } else if (registry.disabledPrompts.has(name)) {
      // Re-enable previously disabled prompt
      const prompt = registry.disabledPrompts.get(name)!;
      prompt.update({ enabled: true, description: skill.description });
      registry.perSkillPrompts.set(name, prompt);
      registry.disabledPrompts.delete(name);
    } else {
      // Register new skill prompt with embedded resource
      const skillPath = skill.path;
      const skillName = name;
      const skillUri = buildSkillResourceUri(skill, "SKILL.md");
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
                      uri: skillUri,
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
