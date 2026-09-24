import { SkillMetadata, DEFAULT_SKILL_SOURCE, SkillSource } from "../skill-discovery.js";
import { SkillState } from "../skill-tool.js";

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
