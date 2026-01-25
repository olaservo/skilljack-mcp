/**
 * MCP App tool registration for skill directory configuration.
 *
 * Registers:
 * - skill-config: Opens the configuration UI
 * - skill-config-add-directory: Adds a directory (UI-only)
 * - skill-config-remove-directory: Removes a directory (UI-only)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  getAllDirectoriesWithSources,
  getConfigState,
  addDirectoryToConfig,
  removeDirectoryFromConfig,
  DirectoryInfo,
} from "./skill-config.js";
import { SkillState } from "./skill-tool.js";

/**
 * Resource URI for the skill-config UI.
 */
const RESOURCE_URI = "ui://skill-config/mcp-app.html";

/**
 * Get the path to the bundled UI HTML file.
 */
function getUIPath(): string {
  // In production (dist/), the UI is at dist/ui/mcp-app.html
  // In development, check multiple locations
  const possiblePaths = [
    // From dist/skill-config-tool.js
    path.join(import.meta.dirname, "ui", "mcp-app.html"),
    // From src/ during development
    path.join(import.meta.dirname, "..", "dist", "ui", "mcp-app.html"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    `UI file not found. Tried: ${possiblePaths.join(", ")}. ` +
      "Run 'npm run build:ui' to build the UI."
  );
}

/**
 * Schema shape for add-directory tool input.
 */
const AddDirectoryInputSchema = {
  directory: z.string().describe("Absolute path to the skills directory to add"),
};

/**
 * Schema shape for remove-directory tool input.
 */
const RemoveDirectoryInputSchema = {
  directory: z.string().describe("Absolute path to the skills directory to remove"),
};

/**
 * Callback type for when directories change.
 */
export type OnDirectoriesChangedCallback = () => void;

/**
 * Register skill-config MCP App tools and resource.
 *
 * @param server - The MCP server instance
 * @param skillState - Shared skill state for getting skill counts
 * @param onDirectoriesChanged - Callback when directories are added/removed
 */
export function registerSkillConfigTool(
  server: McpServer,
  skillState: SkillState,
  onDirectoriesChanged: OnDirectoriesChangedCallback
): void {
  /**
   * Get directory info with skill counts from skillState.
   */
  function getDirectoriesWithCounts(): DirectoryInfo[] {
    const dirs = getAllDirectoriesWithSources();

    // Count skills per directory
    for (const dir of dirs) {
      let count = 0;
      for (const skill of skillState.skillMap.values()) {
        const skillDir = path.dirname(skill.path);
        if (skillDir.startsWith(dir.path)) {
          count++;
        }
      }
      dir.skillCount = count;
    }

    return dirs;
  }

  // Main config tool - opens UI
  registerAppTool(
    server,
    "skill-config",
    {
      title: "Configure Skills",
      description:
        "Open the skills directory configuration UI. " +
        "Use when user wants to configure, add, or remove skill directories.",
      inputSchema: {},
      _meta: { ui: { resourceUri: RESOURCE_URI } },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      const configState = getConfigState();
      const directories = getDirectoriesWithCounts();

      return {
        content: [
          {
            type: "text",
            text: "Skills configuration UI opened.",
          },
        ],
        structuredContent: {
          directories,
          activeSource: configState.activeSource,
          isOverridden: configState.isOverridden,
        },
      };
    }
  );

  // Add directory tool (UI-only, hidden from model)
  registerAppTool(
    server,
    "skill-config-add-directory",
    {
      title: "Add Skills Directory",
      description: "Add a skills directory to the configuration.",
      inputSchema: AddDirectoryInputSchema,
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
      const { directory } = args as { directory: string };

      try {
        addDirectoryToConfig(directory);
        onDirectoriesChanged();

        const directories = getDirectoriesWithCounts();
        return {
          content: [
            {
              type: "text",
              text: `Added directory: ${directory}`,
            },
          ],
          structuredContent: {
            success: true,
            directories,
            activeSource: getConfigState().activeSource,
            isOverridden: getConfigState().isOverridden,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to add directory: ${message}`,
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

  // Remove directory tool (UI-only, hidden from model)
  registerAppTool(
    server,
    "skill-config-remove-directory",
    {
      title: "Remove Skills Directory",
      description: "Remove a skills directory from the configuration.",
      inputSchema: RemoveDirectoryInputSchema,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"], // Hidden from model, UI can call it
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { directory } = args as { directory: string };

      try {
        removeDirectoryFromConfig(directory);
        onDirectoriesChanged();

        const directories = getDirectoriesWithCounts();
        return {
          content: [
            {
              type: "text",
              text: `Removed directory: ${directory}`,
            },
          ],
          structuredContent: {
            success: true,
            directories,
            activeSource: getConfigState().activeSource,
            isOverridden: getConfigState().isOverridden,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to remove directory: ${message}`,
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
    "Skills Configuration UI",
    RESOURCE_URI,
    {
      description: "Interactive UI for configuring skill directories",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (): Promise<ReadResourceResult> => {
      const uiPath = getUIPath();
      const html = fs.readFileSync(uiPath, "utf-8");

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
