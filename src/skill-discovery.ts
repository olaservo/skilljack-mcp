/**
 * Skill discovery and metadata parsing module.
 *
 * Discovers Agent Skills from a directory, parses YAML frontmatter,
 * and generates server instructions XML.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Metadata extracted from a skill's SKILL.md frontmatter.
 */
export interface SkillMetadata {
  name: string;
  description: string;
  path: string; // Full path to SKILL.md
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
 * Discover all skills in a directory.
 * Scans for subdirectories containing SKILL.md files.
 */
export function discoverSkills(skillsDir: string): SkillMetadata[] {
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

      if (typeof name !== "string" || !name.trim()) {
        console.error(`Skill at ${skillDir}: missing or invalid 'name' field`);
        continue;
      }
      if (typeof description !== "string" || !description.trim()) {
        console.error(`Skill at ${skillDir}: missing or invalid 'description' field`);
        continue;
      }

      skills.push({
        name: name.trim(),
        description: description.trim(),
        path: skillMdPath,
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
 */
export function createSkillMap(skills: SkillMetadata[]): Map<string, SkillMetadata> {
  const map = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    map.set(skill.name, skill);
  }
  return map;
}
