/**
 * MCP Resource registration for skill-based resources, aligned with SEP-2640
 * (Skills Extension). Also registers the extension's `skills/list` and
 * `skills/get` methods (see skill-entries.ts).
 *
 * URI Scheme:
 *   skill://<skill-path>/SKILL.md   -> Each skill's SKILL.md (listed in resources/list)
 *   skill://<skill-path>/<file>     -> Individual files inside a skill (listed in
 *                                      resources/list at lower priority than SKILL.md)
 *   skill://index.json              -> Pre-v1 discovery index (application/json), kept
 *                                      for clients that predate skills/list
 *
 * <skill-path> is computed by getSkillPath(): "<prefix>/<baseName>" for prefixed
 * skills (final segment always equals frontmatter `name`), or just "<baseName>"
 * for bundled skills with empty prefix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  McpServer,
  ResourceTemplate,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { Resource, ReadResourceResult } from "@modelcontextprotocol/server";
import { getMimeType as sdkMimeType, isTextMimeType } from "@olaservo/ext-skills";
import { registerSkillMethods } from "./skill-entries.js";
import {
  loadSkillContent,
  getResourceAnnotations,
  buildSkillResourceUri,
  parseSkillResourceUri,
  buildSkillIndex,
} from "./skill-discovery.js";
import { isListedSkillFile, listSkillFiles, MAX_FILE_SIZE, SkillState } from "./skill-tool.js";

/** URI scheme prefix for skill resources. */
const SCHEME = "skill://";

/**
 * Text extensions the SDK's MIME table does not know. Anything not text by
 * this table or the SDK's is served as a base64 blob, so its bytes reach the
 * host unchanged and match the entry's digest.
 */
const EXTRA_TEXT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".tsx": "text/typescript",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".conf": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".rst": "text/x-rst",
  ".tex": "text/x-tex",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".swift": "text/x-swift",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".r": "text/x-r",
  ".ps1": "text/plain",
  ".bat": "text/plain",
};

/**
 * MIME type for a skill file. Falls back to the SDK's table, which returns
 * application/octet-stream for anything it does not recognise.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTRA_TEXT_TYPES[ext] ?? sdkMimeType(filePath);
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
  registerSkillMethods(server, skillState);
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
          // audience/priority are skill-level; lastModified/size must come from
          // each file's own stat (not SKILL.md's), so build fresh per-file
          // annotations rather than sharing one object.
          const { audience, priority } = getResourceAnnotations(skill, 0.3).annotations;
          for (const file of listSkillFiles(skillDir)) {
            const fileResource: Resource = {
              uri: buildSkillResourceUri(skill, file),
              name: `${skill.baseName}/${file}`,
              mimeType: getMimeType(file),
              description: `Supporting file in ${skill.baseName}`,
              annotations: { audience, priority },
            };
            try {
              const stat = fs.statSync(path.resolve(skillDir, file));
              fileResource.size = stat.size;
              fileResource.annotations!.lastModified = stat.mtime.toISOString();
            } catch {
              // Best-effort size/lastModified; omit if the file can't be stat'd.
            }
            resources.push(fileResource);
          }
        }
        return { resources };
      },
      complete: {
        skillUri: (value: string) => {
          // Suggest <skill-path>/SKILL.md plus each supporting file, filtered
          // by substring. Strip the "skill://" scheme from the built URI so the
          // suggested {+skillUri} value is per-segment encoded exactly like the
          // listed resources (names with spaces/reserved chars stay in sync).
          const v = value.toLowerCase();
          const suggestions: string[] = [];
          for (const skill of skillState.skillMap.values()) {
            suggestions.push(buildSkillResourceUri(skill, "SKILL.md").slice(SCHEME.length));
            for (const file of listSkillFiles(path.dirname(skill.path))) {
              suggestions.push(buildSkillResourceUri(skill, file).slice(SCHEME.length));
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
      let parsed: ReturnType<typeof parseSkillResourceUri> = null;
      try {
        parsed = parseSkillResourceUri(uriStr, skillState.skillMap);
      } catch {
        // Malformed percent-encoding: treated as an unknown resource below.
      }

      // Unknown resources are -32602, the code SEP-2640 prescribes for
      // resources/read of a skill file the server does not serve.
      if (!parsed) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Skill resource not found for URI: ${uriStr}`
        );
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
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Failed to load skill "${skill.baseName}": ${message}`
          );
        }
      }

      // Supporting file inside the skill directory. Only files the skill's
      // entry lists are served, so a read can never return content the
      // manifest does not cover (hidden files, symlinks, node_modules).
      const skillDir = path.dirname(skill.path);
      const notServed = () =>
        new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Not a file of skill "${skill.baseName}": ${fileRelPath}`
        );
      if (!isListedSkillFile(skillDir, fileRelPath)) {
        throw notServed();
      }

      const fullPath = path.join(skillDir, fileRelPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        throw notServed();
      }
      if (stat.size > MAX_FILE_SIZE) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}): ${fileRelPath}`
        );
      }

      // Text goes out as UTF-8 text, everything else as a base64 blob, so a
      // host hashing what it receives gets the same bytes the entry digests.
      const bytes = fs.readFileSync(fullPath);
      const mimeType = getMimeType(fileRelPath);
      return {
        contents: [
          {
            uri: uriStr,
            mimeType,
            ...(isTextMimeType(mimeType)
              ? { text: bytes.toString("utf-8") }
              : { blob: bytes.toString("base64") }),
          },
        ],
      };
    }
  );
}
