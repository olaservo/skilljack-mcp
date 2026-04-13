/**
 * Skill discovery and metadata parsing module.
 *
 * Discovers Agent Skills from a directory, parses YAML frontmatter,
 * and generates server instructions XML.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Annotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Source information for a skill.
 * Indicates whether the skill comes from a local directory or GitHub repository.
 */
export interface SkillSource {
  type: "local" | "github" | "bundled";
  displayName: string; // "Local", "owner/repo", or "Bundled"
  prefix: string; // Namespace prefix for skill names (e.g., "my-project", "owner-repo", "" for bundled)
  owner?: string; // GitHub org/user (only for github type)
  repo?: string; // GitHub repo name (only for github type)
}

/**
 * Default source for skills discovered without explicit source info.
 */
export const DEFAULT_SKILL_SOURCE: SkillSource = {
  type: "local",
  displayName: "Local",
  prefix: "local",
};

/**
 * Source for skills bundled with the server package.
 */
export const BUNDLED_SKILL_SOURCE: SkillSource = {
  type: "bundled",
  displayName: "Bundled",
  prefix: "",
};

/**
 * Metadata extracted from a skill's SKILL.md frontmatter.
 */
export interface SkillMetadata {
  name: string; // Qualified name with prefix (e.g., "my-project__commit")
  baseName: string; // Original name from frontmatter (e.g., "commit")
  description: string;
  path: string; // Full path to SKILL.md
  disableModelInvocation?: boolean; // When true, exclude from tool description
  userInvocable?: boolean; // When false, exclude from prompts (default: true)
  metadata?: Record<string, string>; // From frontmatter "metadata" key (Agent Skills spec). Validated but not projected to _meta (metadata is accessible in resource content).
  // Computed effective values (after config overrides applied)
  effectiveAssistantInvocable: boolean; // True if model can auto-invoke
  effectiveUserInvocable: boolean; // True if appears in prompts menu
  isAssistantOverridden: boolean; // True if config override exists
  isUserOverridden: boolean; // True if config override exists
  // Source information
  source: SkillSource; // Where this skill came from (local or GitHub)
}

/**
 * Find the SKILL.md file in a skill directory.
 * Prefers SKILL.md (uppercase) but accepts skill.md (lowercase).
 */
function findSkillMd(skillDir: string): string | null {
  for (const name of ["SKILL.md", "skill.md"]) {
    const filePath = path.join(skillDir, name);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns the parsed metadata and the markdown body.
 */
function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter (---)");
  }

  const parts = content.split("---");
  if (parts.length < 3) {
    throw new Error("SKILL.md frontmatter not properly closed with ---");
  }

  const frontmatterStr = parts[1];
  const body = parts.slice(2).join("---").trim();

  const metadata = parseYaml(frontmatterStr) as Record<string, unknown>;
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }

  return { metadata, body };
}

/**
 * Sanitize a prefix string for use in qualified skill names.
 * Replaces spaces with hyphens and strips special characters.
 */
export function sanitizePrefix(raw: string): string {
  return raw
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9\-_.]/g, "")
    .replace(/^-+|-+$/g, "");
}

/**
 * Regex patterns for MCP _meta key validation.
 * See: https://modelcontextprotocol.io/specification/2025-11-25/basic/index#_meta
 */
const LABEL_PATTERN = /^[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/**
 * Validate a metadata key against MCP spec _meta key naming rules.
 *
 * Valid keys have two segments: an optional prefix and a name.
 * - Prefix: labels separated by dots, followed by `/`. Labels start with a letter,
 *   end with letter/digit, interior can be letters/digits/hyphens.
 *   Implementations SHOULD use reverse DNS notation (e.g., `com.example/`).
 * - Name: starts/ends with alphanumeric, interior can be alphanumerics/hyphens/underscores/dots.
 *   May be empty if prefix is present.
 * - Reserved: prefixes where the second label is `modelcontextprotocol` or `mcp`
 *   (e.g., `io.modelcontextprotocol/`, `dev.mcp/`). Note: `com.example.mcp/` is NOT reserved.
 */
export function validateMetaKey(key: string): { valid: boolean; reserved?: boolean; reason?: string } {
  if (!key) {
    return { valid: false, reason: "key is empty" };
  }

  const slashIndex = key.indexOf("/");
  let name: string;

  if (slashIndex !== -1) {
    const prefix = key.substring(0, slashIndex);
    name = key.substring(slashIndex + 1);

    // Validate prefix labels
    const labels = prefix.split(".");
    for (const label of labels) {
      if (!label || !LABEL_PATTERN.test(label)) {
        return { valid: false, reason: `invalid prefix label "${label}"` };
      }
    }

    // Check reserved prefixes: second label is "modelcontextprotocol" or "mcp" (per 2025-11-25 spec)
    if (labels.length >= 2) {
      const secondLabel = labels[1].toLowerCase();
      if (secondLabel === "modelcontextprotocol" || secondLabel === "mcp") {
        return { valid: true, reserved: true, reason: `prefix "${prefix}/" is reserved for MCP protocol use` };
      }
    }
  } else {
    name = key;
  }

  // Validate name (empty name is valid per spec when prefix is present)
  if (name && !NAME_PATTERN.test(name)) {
    return {
      valid: false,
      reason: `must start/end with alphanumeric, contain only alphanumerics/hyphens/underscores/dots`,
    };
  }

  return { valid: true };
}

/**
 * Compute the qualified name for a skill by combining prefix and base name.
 * If prefix is empty, returns the base name unchanged.
 */
function qualifyName(prefix: string, baseName: string): string {
  const sanitized = sanitizePrefix(prefix);
  if (!sanitized) return baseName;
  return `${sanitized}__${baseName}`;
}

/**
 * Discover all skills in a directory.
 * Scans for subdirectories containing SKILL.md files.
 *
 * @param skillsDir - The directory to scan for skills
 * @param source - Optional source info to attach to discovered skills
 */
export function discoverSkills(skillsDir: string, source?: SkillSource): SkillMetadata[] {
  const skills: SkillMetadata[] = [];

  if (!fs.existsSync(skillsDir)) {
    console.error(`Skills directory not found: ${skillsDir}`);
    return skills;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = findSkillMd(skillDir);

    if (!skillMdPath) continue;

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const { metadata } = parseFrontmatter(content);

      const name = metadata.name;
      const description = metadata.description;
      const disableModelInvocation = metadata["disable-model-invocation"];
      const userInvocable = metadata["user-invocable"];
      const rawMetadata = metadata["metadata"];

      if (typeof name !== "string" || !name.trim()) {
        console.error(`Skill at ${skillDir}: missing or invalid 'name' field`);
        continue;
      }
      if (typeof description !== "string" || !description.trim()) {
        console.error(`Skill at ${skillDir}: missing or invalid 'description' field`);
        continue;
      }

      // Validate metadata: must be a plain object if provided (Agent Skills spec: string keys to string values)
      // Keys are validated against MCP _meta naming rules; invalid/reserved keys are warned and skipped.
      let skillMetadata: Record<string, string> | undefined;
      if (rawMetadata !== undefined && rawMetadata !== null) {
        if (typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
          const validEntries: [string, string][] = [];
          for (const [k, v] of Object.entries(rawMetadata as Record<string, unknown>)) {
            const keyStr = String(k);
            const validation = validateMetaKey(keyStr);
            if (!validation.valid) {
              console.error(`Skill at ${skillDir}: skipping metadata key "${keyStr}": ${validation.reason}`);
              continue;
            }
            if (validation.reserved) {
              console.error(
                `Warning: Skill at ${skillDir}: skipping metadata key "${keyStr}": ${validation.reason}`
              );
              continue;
            }
            // Coerce values to strings per Agent Skills spec
            validEntries.push([keyStr, String(v)]);
          }
          if (validEntries.length > 0) {
            skillMetadata = Object.fromEntries(validEntries);
          }
        } else {
          console.error(
            `Skill at ${skillDir}: 'metadata' must be a YAML mapping (key-value pairs), got ${Array.isArray(rawMetadata) ? "array" : typeof rawMetadata}`
          );
        }
      }

      const effectiveAssistant = disableModelInvocation !== true;
      const effectiveUser = userInvocable !== false;
      const baseName = (name as string).trim();
      const skillSource = source || DEFAULT_SKILL_SOURCE;
      const qualifiedName = qualifyName(skillSource.prefix, baseName);
      skills.push({
        name: qualifiedName,
        baseName,
        description: description.trim(),
        path: skillMdPath,
        disableModelInvocation: disableModelInvocation === true,
        userInvocable: userInvocable !== false, // Default to true
        metadata: skillMetadata,
        // Initialize effective values from frontmatter (overrides applied later)
        effectiveAssistantInvocable: effectiveAssistant,
        effectiveUserInvocable: effectiveUser,
        isAssistantOverridden: false,
        isUserOverridden: false,
        // Source info (local or GitHub)
        source: skillSource,
      });
    } catch (error) {
      console.error(`Failed to parse skill at ${skillDir}:`, error);
    }
  }

  return skills;
}

/**
 * Escape special XML characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate the server instructions with available skills.
 * Includes a brief preamble about skill usage following the Agent Skills spec.
 */
export function generateInstructions(skills: SkillMetadata[]): string {
  const preamble = `# Skills

When a user's task matches a skill description below: 1) activate it, 2) follow its instructions completely.

`;

  if (skills.length === 0) {
    return preamble + "<available_skills>\n</available_skills>";
  }

  const lines: string[] = ["<available_skills>"];

  for (const skill of skills) {
    lines.push("<skill>");
    lines.push(`<name>${escapeXml(skill.name)}</name>`);
    lines.push(`<description>${escapeXml(skill.description)}</description>`);
    lines.push(`<location>${escapeXml(skill.path)}</location>`);
    lines.push("</skill>");
  }

  lines.push("</available_skills>");

  return preamble + lines.join("\n");
}

/**
 * Load the full content of a skill's SKILL.md file.
 */
export function loadSkillContent(skillPath: string): string {
  return fs.readFileSync(skillPath, "utf-8");
}

/**
 * Create a map from skill name to skill metadata for fast lookup.
 * Uses first-wins behavior: if duplicate names exist, the first occurrence is kept.
 */
export function createSkillMap(skills: SkillMetadata[]): Map<string, SkillMetadata> {
  const map = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    if (map.has(skill.name)) {
      const existing = map.get(skill.name)!;
      console.error(
        `Warning: Duplicate skill name "${skill.name}" found at ${skill.path} - ` +
        `keeping first occurrence from ${existing.path}`
      );
    } else {
      map.set(skill.name, skill);
    }
  }
  return map;
}

/**
 * Invocation override settings per skill (imported type reference).
 */
interface SkillInvocationOverrides {
  assistant?: boolean;
  user?: boolean;
}

/**
 * Apply invocation overrides from config to compute effective values.
 * Returns a new array with updated effective* fields.
 */
export function applyInvocationOverrides(
  skills: SkillMetadata[],
  overrides: Record<string, SkillInvocationOverrides>
): SkillMetadata[] {
  return skills.map((skill) => {
    const override = overrides[skill.name];
    if (!override) {
      return skill; // No override, keep frontmatter defaults
    }

    const hasAssistantOverride = override.assistant !== undefined;
    const hasUserOverride = override.user !== undefined;

    return {
      ...skill,
      effectiveAssistantInvocable: hasAssistantOverride
        ? override.assistant!
        : !skill.disableModelInvocation,
      effectiveUserInvocable: hasUserOverride
        ? override.user!
        : skill.userInvocable !== false,
      isAssistantOverridden: hasAssistantOverride,
      isUserOverridden: hasUserOverride,
    };
  });
}

/**
 * Filter skills that can be invoked by the model (appear in tool description).
 * Uses effective value which considers config overrides.
 */
export function getModelInvocableSkills(skills: SkillMetadata[]): SkillMetadata[] {
  return skills.filter((skill) => skill.effectiveAssistantInvocable);
}

/**
 * Filter skills that can be invoked by the user (appear in prompts menu).
 * Uses effective value which considers config overrides.
 */
export function getUserInvocableSkills(skills: SkillMetadata[]): SkillMetadata[] {
  return skills.filter((skill) => skill.effectiveUserInvocable);
}

/**
 * Compute MCP resource annotations and file size for a skill.
 * Derives audience from effective invocation flags and sets default priority.
 *
 * @param skill - The skill metadata
 * @param priority - Priority hint (0.0 = least important, 1.0 = most important, default 0.5)
 * @returns Object with annotations and optional size (in bytes) for use on MCP resources
 */
export function getResourceAnnotations(
  skill: SkillMetadata,
  priority: number = 0.5
): { annotations: Annotations; size?: number } {
  const clampedPriority = Number.isFinite(priority)
    ? Math.max(0, Math.min(1, priority))
    : 0.5;
  const audience: ("user" | "assistant")[] = [];
  if (skill.effectiveAssistantInvocable) {
    audience.push("assistant");
  }
  if (skill.effectiveUserInvocable) {
    audience.push("user");
  }
  const annotations: Annotations = { audience, priority: clampedPriority };
  let size: number | undefined;
  try {
    const stat = fs.statSync(skill.path);
    annotations.lastModified = stat.mtime.toISOString();
    size = stat.size;
  } catch {
    // Skip lastModified/size if file cannot be stat'd
  }
  return { annotations, size };
}

export const SKILL_COUNT_WARNING_THRESHOLD = 50;

export function warnLargeSkillCount(skillCount: number): void {
  if (skillCount >= SKILL_COUNT_WARNING_THRESHOLD) {
    console.error(
      `Warning: ${skillCount} skills discovered. Large skill counts can degrade LLM performance ` +
      `by bloating tool descriptions. Consider reducing the number of skill directories or ` +
      `setting 'disable-model-invocation: true' in SKILL.md frontmatter for user-only skills.`
    );
  }
}
