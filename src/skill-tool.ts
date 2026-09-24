/**
 * MCP tool registration for skill-related tools.
 *
 * - skill: Load and activate a skill by name (returns SKILL.md content)
 * - skill-resource: Read files within a skill directory (scripts/, references/, assets/, etc.)
 *
 * Tools reference a shared SkillState object to support dynamic skill updates
 * when MCP roots change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, RegisteredTool, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SKILLS_EXTENSION_ID } from "@olaservo/ext-skills/server";
import { SkillMetadata, loadSkillContent, generateInstructions, getModelInvocableSkills } from "./skill-discovery.js";

/**
 * Shared state for dynamic skill management.
 * Tools reference this state object, allowing updates when roots change.
 */
export interface SkillState {
  skillMap: Map<string, SkillMetadata>;
}

/**
 * Which channel carries the <available_skills> catalog to the client. The
 * catalog goes through exactly one channel — never both.
 *
 * - "instructions" (default): catalog in server instructions (delivered in the
 *   initialize handshake, so it survives tool-search deferral; frozen at
 *   construction on stdio — the SDK has no way to update instructions).
 * - "tool-description": catalog in the load-skill tool description
 *   (dynamic via tools/listChanged, but invisible to clients that defer MCP
 *   tool descriptions out of context, e.g. Claude Code tool search).
 *
 * Set via `--catalog=<mode>` or SKILLJACK_CATALOG (see getCatalogMode in index.ts).
 */
export type CatalogMode = "tool-description" | "instructions";

/**
 * Whether the load-skill and skill-resource tools are offered.
 *
 * - "auto" (default): offered unless the client declares the
 *   `io.modelcontextprotocol/skills` extension in its capabilities, in which
 *   case the host loads skills itself via skills/list, skills/get and
 *   resources/read, and the tools are disabled after initialize.
 * - "always": offered to every client.
 * - "never": never registered as enabled.
 *
 * Set via `--tools=<mode>` or SKILLJACK_TOOLS (see getToolsMode in index.ts).
 */
export type ToolsMode = "auto" | "always" | "never";

/** Handles for the two skill tools, so their mode can be applied after initialize. */
export interface SkillTools {
  loadSkill: RegisteredTool;
  skillResource: RegisteredTool;
}

/**
 * Input schema for the skill tool.
 */
const SkillSchema = z.object({
  name: z.string().describe("Skill name from <available_skills>"),
});

/**
 * Register the "load-skill" tool with the MCP server.
 *
 * Named `load-skill` (not `skill`) to avoid colliding with Claude Code's built-in
 * `Skill` tool. When both are present, the model defaults to the built-in one even
 * if our catalog is the relevant source; a distinct verb-first name removes that
 * routing ambiguity.
 *
 * The tool description includes the full skill discovery instructions (same format as
 * server instructions) to enable dynamic updates via tools/listChanged notifications.
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 * @returns The registered tool, which can be updated when skills change
 */
/**
 * Generate the full tool description including usage guidance and skill list.
 * Exported so index.ts can use it when refreshing skills.
 */
const LOAD_SKILL_USAGE =
  "Load a skill's full instructions. Returns the complete SKILL.md content " +
  "with step-by-step guidance, examples, and file references to follow.\n\n" +
  "IMPORTANT: When a skill is relevant to the user's task, you must invoke this tool " +
  "IMMEDIATELY as your first action. NEVER just announce or mention a skill without " +
  "actually calling this tool. This is a BLOCKING REQUIREMENT: invoke this tool BEFORE " +
  "generating any other response about the task.\n\n";

export function getToolDescription(
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions"
): string {
  if (catalogMode === "instructions") {
    // Catalog lives in server instructions; keep the description to usage only.
    return LOAD_SKILL_USAGE.trimEnd();
  }
  const allSkills = Array.from(skillState.skillMap.values());
  const modelInvocableSkills = getModelInvocableSkills(allSkills);
  return LOAD_SKILL_USAGE + generateInstructions(modelInvocableSkills);
}

/**
 * Server-instructions text for `--catalog=instructions` mode: the same usage
 * preamble + <available_skills> catalog that normally lives in the load-skill
 * tool description. The preamble names the tool because under tool search the
 * model may never see the tool description itself.
 */
export function getCatalogInstructions(
  skillState: SkillState,
  toolsMode: ToolsMode = "auto"
): string {
  const allSkills = Array.from(skillState.skillMap.values());
  const modelInvocableSkills = getModelInvocableSkills(allSkills);
  const intro =
    "This server serves Agent Skills. Each <skill> below lists its name, description " +
    "and the skill:// URI of its SKILL.md.\n\n";
  const viaTool =
    "call `load-skill` with the skill's name; it returns the complete SKILL.md " +
    "content with step-by-step guidance, examples, and file references to follow.";
  const howToLoad =
    toolsMode === "never"
      ? "This server offers no skill-loading tool. Load a skill by that URI through " +
        "your host's skill loader (MCP skills extension " +
        `${SKILLS_EXTENSION_ID}), or read the URI with resources/read.\n\n`
      : toolsMode === "always"
        ? "Hosts that support the MCP skills extension " +
          `(${SKILLS_EXTENSION_ID}) may load a skill by that URI through their own ` +
          `skill loader. Otherwise ${viaTool}\n\n`
        : "If your host supports the MCP skills extension " +
          `(${SKILLS_EXTENSION_ID}), it loads a skill by that URI through its own ` +
          "skill loader and this server does not offer the `load-skill` tool. " +
          `Otherwise ${viaTool}\n\n`;
  const urgency =
    "IMPORTANT: When a skill is relevant to the user's task, you must load it " +
    "IMMEDIATELY as your first action. NEVER just announce or mention a skill " +
    "without actually loading it. This is a BLOCKING REQUIREMENT: load the skill " +
    "BEFORE generating any other response about the task.\n\n";
  return intro + howToLoad + urgency + generateInstructions(modelInvocableSkills);
}

/**
 * Server `instructions` value for a given catalog mode, or undefined to omit
 * the field. Used by both server construction sites (index.ts stdio,
 * http-transport.ts). Only "instructions" mode emits instructions — the
 * catalog is never delivered through both channels at once.
 */
export function getServerInstructions(
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions",
  toolsMode: ToolsMode = "auto"
): string | undefined {
  if (catalogMode === "instructions") {
    return getCatalogInstructions(skillState, toolsMode);
  }
  return undefined;
}

export function registerSkillTool(
  server: McpServer,
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions"
): SkillTools {
  const skillTool = server.registerTool(
    "load-skill",
    {
      title: "Load Skill",
      description: getToolDescription(skillState, catalogMode),
      inputSchema: SkillSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { name } = SkillSchema.parse(args);
      const skill = skillState.skillMap.get(name);

      if (!skill) {
        const availableSkills = Array.from(skillState.skillMap.keys()).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Skill "${name}" not found. Available skills: ${availableSkills || "none"}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const content = loadSkillContent(skill.path);
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to load skill "${name}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const skillResource = registerSkillResourceTool(server, skillState);

  return { loadSkill: skillTool, skillResource };
}

/** Whether the connected client declared the skills extension in its capabilities. */
export function clientDeclaresSkillsExtension(server: McpServer): boolean {
  const extensions = server.server.getClientCapabilities()?.extensions;
  return extensions !== undefined && SKILLS_EXTENSION_ID in extensions;
}

function disableSkillTools(tools: SkillTools): void {
  tools.loadSkill.disable();
  tools.skillResource.disable();
}

/**
 * Apply a ToolsMode. "never" disables the tools now; "auto" waits for the
 * initialize handshake and disables them when the client declared the skills
 * extension. Call immediately before connect(), since it hooks
 * `server.server.oninitialized` and a later assignment would replace it.
 *
 * In the legacy tool-description catalog mode the catalog lives in the
 * load-skill description, so auto leaves the tools on there. On the stateless
 * HTTP transport tools/list arrives on a fresh server instance, so callers
 * pass "always" in place of "auto" (see buildCoreServer).
 */
export function installToolsMode(
  server: McpServer,
  tools: SkillTools,
  mode: ToolsMode,
  catalogMode: CatalogMode = "instructions"
): void {
  if (mode === "always") return;
  if (mode === "never") {
    disableSkillTools(tools);
    return;
  }
  if (catalogMode === "tool-description") {
    console.error(
      "--tools=auto has no effect with --catalog=tool-description: the skill catalog lives in the " +
        "load-skill tool description, so the tools stay enabled for every client."
    );
    return;
  }
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    if (clientDeclaresSkillsExtension(server)) {
      disableSkillTools(tools);
      console.error(
        `Client declares ${SKILLS_EXTENSION_ID}; load-skill and skill-resource tools disabled (--tools=auto)`
      );
    }
  };
}

/**
 * Input schema for the skill-resource tool.
 *
 * Per the Agent Skills spec, file references use relative paths from the skill root.
 * Common directories: scripts/, references/, assets/
 */
const SkillResourceSchema = z.object({
  skill: z.string().describe("Skill name"),
  path: z
    .string()
    .describe("Relative path to file or directory. Examples: 'snippets/tool.ts' (single file), 'templates' (all files in directory), '' (list available files)."),
});

// Security constants (exported for reuse in skill-resources.ts)
const DEFAULT_MAX_FILE_SIZE_MB = 1;
const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || "", 10) || DEFAULT_MAX_FILE_SIZE_MB;
export const MAX_FILE_SIZE = maxFileSizeMB * 1024 * 1024; // Configurable via MAX_FILE_SIZE_MB env var
export const MAX_DIRECTORY_DEPTH = 10; // Prevent deeply nested traversal

/**
 * Check if a path is within the allowed base directory.
 * Uses fs.realpathSync to resolve symlinks and prevent symlink escape attacks.
 */
export function isPathWithinBase(targetPath: string, baseDir: string): boolean {
  try {
    // Resolve symlinks to get the real paths
    const realBase = fs.realpathSync(baseDir);
    const realTarget = fs.realpathSync(targetPath);

    const normalizedBase = realBase + path.sep;
    return realTarget === realBase || realTarget.startsWith(normalizedBase);
  } catch {
    // If realpathSync fails (e.g., file doesn't exist), fall back to resolve check
    // This is safe because we'll get an error when trying to read anyway
    const normalizedBase = path.resolve(baseDir);
    const normalizedPath = path.resolve(targetPath);
    return normalizedPath === normalizedBase || normalizedPath.startsWith(normalizedBase + path.sep);
  }
}

/**
 * List files in a skill directory for discovery.
 * Limits recursion depth to prevent DoS from deeply nested directories.
 */
export function listSkillFiles(skillDir: string, subPath: string = "", depth: number = 0): string[] {
  // Prevent excessive recursion
  if (depth > MAX_DIRECTORY_DEPTH) {
    return [];
  }

  const files: string[] = [];
  const dirPath = path.join(skillDir, subPath);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return files;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(subPath, entry.name);

    // Skip symlinks to prevent escape and infinite loops
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        files.push(...listSkillFiles(skillDir, relativePath, depth + 1));
      }
    } else {
      // Skip SKILL.md (use skill tool for that), and hidden files (e.g. .env,
      // .npmrc) so secrets sitting in a skill dir are never enumerated into
      // resources/list or surfaced by the skill-resource tool.
      if (
        !entry.name.startsWith(".") &&
        entry.name !== "SKILL.md" &&
        entry.name !== "skill.md"
      ) {
        files.push(relativePath.replace(/\\/g, "/"));
      }
    }
  }

  return files;
}

/**
 * Whether `rel` names a file `listSkillFiles(skillDir)` would enumerate,
 * answered with per-segment checks and one lstat per path component instead
 * of a directory walk. Applies the same rules: no hidden segments, no
 * node_modules, no symlinks, no SKILL.md, depth at most MAX_DIRECTORY_DEPTH.
 */
export function isListedSkillFile(skillDir: string, rel: string): boolean {
  if (rel === "" || path.isAbsolute(rel)) return false;
  const segments = rel.split("/");
  const dirs = segments.slice(0, -1);
  const leaf = segments[segments.length - 1];
  if (dirs.length > MAX_DIRECTORY_DEPTH) return false;
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return false;
  }
  if (dirs.includes("node_modules")) return false;
  if (leaf === "SKILL.md" || leaf === "skill.md") return false;

  let current = skillDir;
  for (const seg of dirs) {
    current = path.join(current, seg);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false;
    }
    // lstat reports a symlink as a symlink, never as a directory.
    if (!stat.isDirectory()) return false;
  }
  try {
    return fs.lstatSync(path.join(current, leaf)).isFile();
  } catch {
    return false;
  }
}

/**
 * Register the "skill-resource" tool with the MCP server.
 *
 * This tool provides access to files within a skill's directory structure,
 * following the Agent Skills spec for progressive disclosure of resources.
 *
 * @param server - The McpServer instance
 * @param skillState - Shared state object (allows dynamic updates)
 */
function registerSkillResourceTool(
  server: McpServer,
  skillState: SkillState
): RegisteredTool {
  return server.registerTool(
    "skill-resource",
    {
      title: "Read Skill File",
      description:
        "Read files referenced by skill instructions (scripts, snippets, templates). " +
        "Use when skill instructions mention specific files to read or copy. " +
        "Pass a directory path (e.g., 'templates') to read all files in that directory at once.",
      inputSchema: SkillResourceSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { skill: skillName, path: resourcePath } = SkillResourceSchema.parse(args);
      const skill = skillState.skillMap.get(skillName);

      if (!skill) {
        const availableSkills = Array.from(skillState.skillMap.keys()).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Skill "${skillName}" not found. Available skills: ${availableSkills || "none"}`,
            },
          ],
          isError: true,
        };
      }

      // Get the skill directory (parent of SKILL.md)
      const skillDir = path.dirname(skill.path);

      // If path is empty, list available files
      if (!resourcePath || resourcePath.trim() === "") {
        const files = listSkillFiles(skillDir);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No resource files found in skill "${skillName}". The skill only contains SKILL.md.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Available resources in skill "${skillName}":\n\n${files.map((f) => `- ${f}`).join("\n")}`,
            },
          ],
        };
      }

      // Resolve the full path and validate it's within the skill directory
      const fullPath = path.resolve(skillDir, resourcePath);

      if (!isPathWithinBase(fullPath, skillDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid path: "${resourcePath}" is outside the skill directory. Use relative paths like "scripts/example.py" or "references/guide.md".`,
            },
          ],
          isError: true,
        };
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        const files = listSkillFiles(skillDir);
        const suggestions = files.slice(0, 10).join("\n- ");
        return {
          content: [
            {
              type: "text",
              text: `Resource "${resourcePath}" not found in skill "${skillName}".\n\nAvailable files:\n- ${suggestions}${files.length > 10 ? `\n... and ${files.length - 10} more` : ""}`,
            },
          ],
          isError: true,
        };
      }

      // Check file stats
      const stat = fs.statSync(fullPath);

      // Reject symlinks that point outside (defense in depth)
      if (stat.isSymbolicLink()) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot read symlink "${resourcePath}". Only regular files within the skill directory are accessible.`,
            },
          ],
          isError: true,
        };
      }

      // Handle directories - return all file contents
      if (stat.isDirectory()) {
        const files = listSkillFiles(skillDir, resourcePath);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Directory "${resourcePath}" is empty or contains no readable files.`,
              },
            ],
          };
        }

        // Read all files and return as multiple content items
        const contents: Array<{ type: "text"; text: string }> = [];
        for (const file of files) {
          const filePath = path.join(skillDir, file);
          try {
            const fileStat = fs.statSync(filePath);
            if (fileStat.size > MAX_FILE_SIZE) {
              contents.push({
                type: "text",
                text: `--- ${file} ---\n[File too large: ${(fileStat.size / 1024 / 1024).toFixed(2)}MB]`,
              });
            } else {
              const fileContent = fs.readFileSync(filePath, "utf-8");
              contents.push({
                type: "text",
                text: `--- ${file} ---\n${fileContent}`,
              });
            }
          } catch (error) {
            contents.push({
              type: "text",
              text: `--- ${file} ---\n[Error reading file: ${error instanceof Error ? error.message : "unknown error"}]`,
            });
          }
        }

        return { content: contents };
      }

      // Check file size to prevent memory exhaustion
      if (stat.size > MAX_FILE_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
        return {
          content: [
            {
              type: "text",
              text: `File "${resourcePath}" is too large (${sizeMB}MB). Maximum allowed size is ${maxMB}MB.`,
            },
          ],
          isError: true,
        };
      }

      // Final symlink check using realpath (defense in depth)
      if (!isPathWithinBase(fullPath, skillDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: "${resourcePath}" resolves to a location outside the skill directory.`,
            },
          ],
          isError: true,
        };
      }

      // Read and return the file content
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to read resource "${resourcePath}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
