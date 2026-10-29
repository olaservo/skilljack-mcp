import { z } from "zod";
import { SkillMetadata, DEFAULT_SKILL_SOURCE, SkillSource } from "../skill-discovery.js";
import { SkillState } from "../skill-tool.js";

/**
 * Result schemas for raw `skills/list` / `skills/get` requests. The SDK's own
 * schemas follow the stable spec and require `ttlMs` / `cacheScope`, which a
 * 2025-era connection never carries, so these leave them optional.
 */
const SkillEntrySchema = z.looseObject({
  uri: z.string(),
  frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
  resources: z.union([
    z.array(z.looseObject({ uri: z.string(), digest: z.string(), size: z.number() })),
    z.literal("dynamic"),
  ]),
});
const cacheFields = {
  ttlMs: z.number().optional(),
  cacheScope: z.enum(["public", "private"]).optional(),
};
export const LooseListSkillsResultSchema = z.looseObject({
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
  ...cacheFields,
});
export const LooseGetSkillResultSchema = z.looseObject({ skill: SkillEntrySchema, ...cacheFields });
export const LooseDirectoryReadResultSchema = z.looseObject({
  resources: z.array(z.looseObject({ uri: z.string(), name: z.string(), mimeType: z.string().optional(), size: z.number().optional() })),
  nextCursor: z.string().optional(),
  ...cacheFields,
});

/**
 * Create a test SkillMetadata with sensible defaults.
 */
export function createTestSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  const skill: SkillMetadata = {
    name: "test__skill",
    baseName: "skill",
    description: "A test skill",
    path: "/fake/path/SKILL.md",
    frontmatter: {},
    effectiveAssistantInvocable: true,
    effectiveUserInvocable: true,
    isAssistantOverridden: false,
    isUserOverridden: false,
    source: DEFAULT_SKILL_SOURCE,
    ...overrides,
  };
  if (!overrides.frontmatter) {
    skill.frontmatter = { name: skill.baseName, description: skill.description };
  }
  return skill;
}

/**
 * Create a SkillState from an array of skills.
 */
export function createTestSkillState(skills: SkillMetadata[] = []): SkillState {
  const map = new Map<string, SkillMetadata>();
  for (const s of skills) {
    map.set(s.name, s);
  }
  return { skillMap: map };
}

/**
 * Create a test SkillSource.
 */
export function createTestSource(overrides: Partial<SkillSource> = {}): SkillSource {
  return {
    type: "local",
    displayName: "Test",
    prefix: "test",
    ...overrides,
  };
}
