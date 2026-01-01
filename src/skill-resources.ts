/**
 * MCP Resource registration for skill-based resources.
 *
 * Resources provide application-controlled access to skill content,
 * complementing the model-controlled tool access.
 *
 * URI Scheme:
 *   skill://{skillName}         -> SKILL.md content
 *   skill://{skillName}/{path}  -> File within skill directory
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkillMetadata, loadSkillContent } from "./skill-discovery.js";
import { isPathWithinBase, listSkillFiles, MAX_FILE_SIZE } from "./skill-tool.js";

/**
 * Get MIME type based on file extension.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".md": "text/markdown",
    ".ts": "text/typescript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".txt": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".css": "text/css",
    ".html": "text/html",
    ".xml": "application/xml",
  };
  return mimeTypes[ext] || "text/plain";
}

/**
 * Register skill resources with the MCP server.
 *
 * This registers:
 * 1. Static resources for each skill's SKILL.md
 * 2. A resource template for accessing files within skills
 *
 * @param server - The McpServer instance
 * @param skillMap - Map from skill name to metadata
 */
export function registerSkillResources(
  server: McpServer,
  skillMap: Map<string, SkillMetadata>
): void {
  // Register static resources for each skill's SKILL.md
  for (const [name, skill] of skillMap) {
    const uri = `skill://${encodeURIComponent(name)}`;

    server.registerResource(
      name,
      uri,
      {
        mimeType: "text/markdown",
        description: skill.description,
      },
      async (resourceUri) => {
        try {
          const content = loadSkillContent(skill.path);
          return {
            contents: [
              {
                uri: resourceUri.toString(),
                mimeType: "text/markdown",
                text: content,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to load skill "${name}": ${message}`);
        }
      }
    );
  }

  // Register resource template for skill files
  registerSkillFileTemplate(server, skillMap);
}

/**
 * Register the resource template for accessing files within skills.
 *
 * URI Pattern: skill://{skillName}/{filePath}
 */
function registerSkillFileTemplate(
  server: McpServer,
  skillMap: Map<string, SkillMetadata>
): void {
  // Create a completer for skill names
  const skillNameCompleter = (value: string) => {
    const names = Array.from(skillMap.keys());
    return names.filter((name) => name.toLowerCase().startsWith(value.toLowerCase()));
  };

  server.registerResource(
    "Skill File",
    new ResourceTemplate("skill://{skillName}/{+filePath}", {
      list: async () => {
        // Return all listable skill files
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];

        for (const [name, skill] of skillMap) {
          const skillDir = path.dirname(skill.path);
          const files = listSkillFiles(skillDir);

          for (const file of files) {
            const uri = `skill://${encodeURIComponent(name)}/${file}`;
            resources.push({
              uri,
              name: `${name}/${file}`,
              mimeType: getMimeType(file),
            });
          }
        }

        return { resources };
      },
      complete: {
        skillName: skillNameCompleter,
      },
    }),
    {
      mimeType: "text/plain",
      description: "Files within a skill directory (scripts, snippets, assets, etc.)",
    },
    async (resourceUri, variables) => {
      // Extract skill name and file path from URI
      const uriStr = resourceUri.toString();
      const match = uriStr.match(/^skill:\/\/([^/]+)\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid skill file URI: ${uriStr}`);
      }

      const skillName = decodeURIComponent(match[1]);
      const filePath = match[2];

      const skill = skillMap.get(skillName);
      if (!skill) {
        const available = Array.from(skillMap.keys()).join(", ");
        throw new Error(`Skill "${skillName}" not found. Available: ${available || "none"}`);
      }

      const skillDir = path.dirname(skill.path);
      const fullPath = path.resolve(skillDir, filePath);

      // Security: Validate path is within skill directory
      if (!isPathWithinBase(fullPath, skillDir)) {
        throw new Error(`Path "${filePath}" is outside the skill directory`);
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        const files = listSkillFiles(skillDir).slice(0, 10);
        throw new Error(
          `File "${filePath}" not found in skill "${skillName}". ` +
            `Available: ${files.join(", ")}${files.length >= 10 ? "..." : ""}`
        );
      }

      const stat = fs.statSync(fullPath);

      // Reject symlinks
      if (stat.isSymbolicLink()) {
        throw new Error(`Cannot read symlink "${filePath}"`);
      }

      // Reject directories
      if (stat.isDirectory()) {
        const files = listSkillFiles(skillDir, filePath);
        throw new Error(`"${filePath}" is a directory. Files within: ${files.join(", ")}`);
      }

      // Check file size
      if (stat.size > MAX_FILE_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        throw new Error(`File too large (${sizeMB}MB). Maximum: 10MB`);
      }

      // Read and return content
      const content = fs.readFileSync(fullPath, "utf-8");
      const mimeType = getMimeType(fullPath);

      return {
        contents: [
          {
            uri: uriStr,
            mimeType,
            text: content,
          },
        ],
      };
    }
  );
}
