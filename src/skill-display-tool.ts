/**
 * MCP App tool registration for skill display UI.
 *
 * Registers:
 * - skill-display: Opens the skill display UI
 * - skill-display-update-invocation: Updates invocation settings (UI-only)
 * - skill-display-reset-override: Resets a skill to frontmatter defaults (UI-only)
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { McpServer, CallToolResult, ReadResourceResult } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "./ui-meta.js";
import { z } from "zod";
import {
  getSkillInvocationOverrides,
  setSkillInvocationOverride,
  clearSkillInvocationOverride,
} from "./skill-config.js";
import { SkillState } from "./skill-tool.js";

/**
 * Resource URI for the skill-display UI.
 */
const RESOURCE_URI = "ui://skill-display/skill-display.html";

/**
 * Get the path to the bundled UI HTML file.
 */
function getUIPath(): string {
  const possiblePaths = [
    // From dist/skill-display-tool.js
    path.join(import.meta.dirname, "ui", "skill-display.html"),
    // From src/ during development
    path.join(import.meta.dirname, "..", "dist", "ui", "skill-display.html"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    `UI file not found. Tried: ${possiblePaths.join(", ")}. ` +
      "Run 'npm run build:ui:display' to build the UI."
  );
}

/**
 * Input schema for the update-invocation tool.
 */
const UpdateInvocationInputSchema = z.object({
  skillName: z.string().describe("Name of the skill to update"),
  setting: z.enum(["assistant", "user"]).describe("Which setting to update"),
  value: z.boolean().describe("New value for the setting"),
});

/**
 * Input schema for the reset-override tool.
 */
const ResetOverrideInputSchema = z.object({
  skillName: z.string().describe("Name of the skill to reset"),
  setting: z.enum(["assistant", "user"]).optional().describe("Which setting to reset (omit for both)"),
});

/**
 * Output schema fragment describing one skill in the display UI.
 * Shared by every skill-display tool that returns the skill list.
 */
const SkillDisplayOutputSchema = z.object({
  name: z.string(),
  baseName: z.string(),
  description: z.string(),
  path: z.string(),
  assistantInvocable: z.boolean(),
  userInvocable: z.boolean(),
  isAssistantOverridden: z.boolean(),
  isUserOverridden: z.boolean(),
  sourceType: z.enum(["local", "github", "bundled", "well-known"]),
  sourceDisplayName: z.string(),
  sourceOwner: z.string().optional(),
  sourceRepo: z.string().optional(),
});

/**
 * Callback type for when invocation settings change.
 */
export type OnInvocationChangedCallback = () => void;

/**
 * Skill info structure for UI display.
 */
interface SkillDisplayInfo {
  name: string;
  baseName: string;
  description: string;
  path: string;
  assistantInvocable: boolean;
  userInvocable: boolean;
  isAssistantOverridden: boolean;
  isUserOverridden: boolean;
  // Source information
  sourceType: "local" | "github" | "bundled" | "well-known";
  sourceDisplayName: string;
  sourceOwner?: string;
  sourceRepo?: string;
}

/**
 * Get skill display info from skill state.
 */
function getSkillDisplayInfo(skillState: SkillState): SkillDisplayInfo[] {
  const skills: SkillDisplayInfo[] = [];
  for (const skill of skillState.skillMap.values()) {
    skills.push({
      name: skill.name,
      baseName: skill.baseName,
      description: skill.description,
      path: skill.path,
      assistantInvocable: skill.effectiveAssistantInvocable,
      userInvocable: skill.effectiveUserInvocable,
      isAssistantOverridden: skill.isAssistantOverridden,
      isUserOverridden: skill.isUserOverridden,
      // Source info
      sourceType: skill.source.type,
      sourceDisplayName: skill.source.displayName,
      sourceOwner: skill.source.owner,
      sourceRepo: skill.source.repo,
    });
  }
  // Sort by name for consistent display
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Register skill-display MCP App tools and resource.
 *
 * @param server - The MCP server instance
 * @param skillState - Shared skill state for getting skill info
 * @param onInvocationChanged - Callback when invocation settings are changed
 */
export function registerSkillDisplayTool(
  server: McpServer,
  skillState: SkillState,
  onInvocationChanged: OnInvocationChangedCallback
): void {
  // Main display tool - opens UI
  registerAppTool(
    server,
    "skill-display",
    {
      title: "View Skills",
      description:
        "Open the skill display UI to view available skills and configure their invocation settings. " +
        "Use when user wants to see skills or toggle assistant/user invocation.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        skills: z.array(SkillDisplayOutputSchema),
        totalCount: z.number(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      const skills = getSkillDisplayInfo(skillState);

      return {
        content: [
          {
            type: "text",
            text: `Skill display UI opened. ${skills.length} skill(s) available.`,
          },
        ],
        structuredContent: {
          skills,
          totalCount: skills.length,
        },
      };
    }
  );

  // Update invocation tool (UI-only, hidden from model)
  registerAppTool(
    server,
    "skill-display-update-invocation",
    {
      title: "Update Skill Invocation",
      description: "Update invocation settings for a skill.",
      inputSchema: UpdateInvocationInputSchema,
      outputSchema: z.object({
        success: z.boolean(),
        skills: z.array(SkillDisplayOutputSchema).optional(),
        totalCount: z.number().optional(),
        error: z.string().optional(),
      }),
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"], // Hidden from model, UI can call it
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { skillName, setting, value } = args as {
        skillName: string;
        setting: "assistant" | "user";
        value: boolean;
      };

      try {
        // Verify skill exists
        if (!skillState.skillMap.has(skillName)) {
          throw new Error(`Skill not found: ${skillName}`);
        }

        // Update the override
        setSkillInvocationOverride(skillName, setting, value);

        // Trigger refresh to apply the new override
        onInvocationChanged();

        // Return updated skill list
        const skills = getSkillDisplayInfo(skillState);
        return {
          content: [
            {
              type: "text",
              text: `Updated ${skillName}: ${setting} = ${value}`,
            },
          ],
          structuredContent: {
            success: true,
            skills,
            totalCount: skills.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to update invocation: ${message}`,
            },
          ],
          structuredContent: {
            success: false,
            error: message,
          },
          isError: true,
        };
      }
    }
  );

  // Reset override tool (UI-only, hidden from model)
  registerAppTool(
    server,
    "skill-display-reset-override",
    {
      title: "Reset Skill Override",
      description: "Reset a skill's invocation settings to frontmatter defaults.",
      inputSchema: ResetOverrideInputSchema,
      outputSchema: z.object({
        success: z.boolean(),
        skills: z.array(SkillDisplayOutputSchema).optional(),
        totalCount: z.number().optional(),
        error: z.string().optional(),
      }),
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"], // Hidden from model, UI can call it
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { skillName, setting } = args as {
        skillName: string;
        setting?: "assistant" | "user";
      };

      try {
        // Verify skill exists
        if (!skillState.skillMap.has(skillName)) {
          throw new Error(`Skill not found: ${skillName}`);
        }

        // Clear the override
        clearSkillInvocationOverride(skillName, setting);

        // Trigger refresh to apply the change
        onInvocationChanged();

        // Return updated skill list
        const skills = getSkillDisplayInfo(skillState);
        const settingText = setting ? setting : "all settings";
        return {
          content: [
            {
              type: "text",
              text: `Reset ${skillName} (${settingText}) to frontmatter default`,
            },
          ],
          structuredContent: {
            success: true,
            skills,
            totalCount: skills.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to reset override: ${message}`,
            },
          ],
          structuredContent: {
            success: false,
            error: message,
          },
          isError: true,
        };
      }
    }
  );

  // Register the HTML UI resource
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const uiPath = getUIPath();
      const html = await fsPromises.readFile(uiPath, "utf-8");

      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    }
  );
}
