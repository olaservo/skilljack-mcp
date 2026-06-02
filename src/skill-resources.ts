/**
 * MCP Resource registration for skill-based resources, aligned with SEP-2640
 * (Skills Extension).
 *
 * URI Scheme:
 *   skill://<skill-path>/SKILL.md   -> Each skill's SKILL.md (listed in resources/list)
 *   skill://<skill-path>/<file>     -> Individual files inside a skill (listed in
 *                                      resources/list at lower priority than SKILL.md)
 *   skill://index.json              -> SEP-2640 discovery index (application/json)
 *
 * <skill-path> is computed by getSkillPath(): "<prefix>/<baseName>" for prefixed
 * skills (final segment always equals frontmatter `name`), or just "<baseName>"
 * for bundled skills with empty prefix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import {
  loadSkillContent,
  getResourceAnnotations,
  buildSkillResourceUri,
  parseSkillResourceUri,
  buildSkillIndex,
  getSkillPath,
} from "./skill-discovery.js";
import { isPathWithinBase, listSkillFiles, MAX_FILE_SIZE, SkillState } from "./skill-tool.js";

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
 */
export function registerSkillResources(
  server: McpServer,
  skillState: SkillState
): void {
  registerSkillIndexResource(server, skillState);
  registerSkillTemplate(server, skillState);
}

/**
 * Register the SEP-2640 discovery index at skill://index.json.
 */
function registerSkillIndexResource(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "Skill Index",
    "skill://index.json",
    {
      mimeType: "application/json",
      description: "SEP-2640 Agent Skills discovery index",
      annotations: { audience: ["assistant", "user"], priority: 0.5 },
    },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(buildSkillIndex(skillState.skillMap), null, 2),
        },
      ],
    })
  );
}

/**
 * Register a single template that covers every skill:// URI other than
 * the exact index resource. The list callback enumerates only SKILL.md
 * resources (one per skill); the read handler dispatches between SKILL.md
 * and supporting-file reads.
 */
function registerSkillTemplate(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "Skill",
    new ResourceTemplate("skill://{+skillUri}", {
      list: async () => {
        const resources: Resource[] = [];
        for (const skill of skillState.skillMap.values()) {
          const { annotations, size } = getResourceAnnotations(skill, 0.8);
          const resource: Resource = {
            uri: buildSkillResourceUri(skill, "SKILL.md"),
            name: skill.baseName,
            mimeType: "text/markdown",
            description: skill.description,
            annotations,
          };
          if (size !== undefined) {
            resource.size = size;
          }
          resources.push(resource);

          // List each supporting file as its own resource, below SKILL.md.
          // Reuses the same enumeration as the skill-resource tool so listing
          // and tool behavior stay consistent (symlinks/SKILL.md/node_modules/
          // hidden dirs already filtered; recurses to MAX_DIRECTORY_DEPTH).
          const skillDir = path.dirname(skill.path);
          const fileAnnotations = getResourceAnnotations(skill, 0.3).annotations;
          for (const file of listSkillFiles(skillDir)) {
            const fileResource: Resource = {
              uri: buildSkillResourceUri(skill, file),
              name: `${skill.baseName}/${file}`,
              mimeType: getMimeType(file),
              description: `Supporting file in ${skill.baseName}`,
              annotations: fileAnnotations,
            };
            try {
              fileResource.size = fs.statSync(path.resolve(skillDir, file)).size;
            } catch {
              // Best-effort size; omit if the file can't be stat'd.
            }
            resources.push(fileResource);
          }
        }
        return { resources };
      },
      complete: {
        skillUri: (value: string) => {
          // Suggest <skill-path>/SKILL.md plus each supporting file, filtered
          // by substring, so completions match the listed resources.
          const v = value.toLowerCase();
          const suggestions: string[] = [];
          for (const skill of skillState.skillMap.values()) {
            const base = getSkillPath(skill);
            suggestions.push(`${base}/SKILL.md`);
            for (const file of listSkillFiles(path.dirname(skill.path))) {
              suggestions.push(`${base}/${file}`);
            }
          }
          return suggestions.filter((u) => u.toLowerCase().includes(v));
        },
      },
    }),
    {
      mimeType: "text/markdown",
      description: "Agent Skill resource (SEP-2640)",
    },
    async (resourceUri) => {
      const uriStr = resourceUri.toString();
      const parsed = parseSkillResourceUri(uriStr, skillState.skillMap);

      if (!parsed) {
        throw new Error(`Skill resource not found for URI: ${uriStr}`);
      }

      const { skill, fileRelPath } = parsed;

      if (fileRelPath === "SKILL.md") {
        try {
          const content = loadSkillContent(skill.path);
          return {
            contents: [
              {
                uri: uriStr,
                mimeType: "text/markdown",
                text: content,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to load skill "${skill.baseName}": ${message}`);
        }
      }

      // Supporting file inside the skill directory.
      const skillDir = path.dirname(skill.path);
      const fullPath = path.resolve(skillDir, fileRelPath);

      if (!isPathWithinBase(fullPath, skillDir)) {
        throw new Error(`Path traversal blocked: ${fileRelPath}`);
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        throw new Error(`File not found: ${fileRelPath}`);
      }

      if (stat.isSymbolicLink() || stat.isDirectory()) {
        throw new Error(`Not a readable file: ${fileRelPath}`);
      }
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}): ${fileRelPath}`
        );
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      return {
        contents: [
          {
            uri: uriStr,
            mimeType: getMimeType(fileRelPath),
            text: content,
          },
        ],
      };
    }
  );
}
