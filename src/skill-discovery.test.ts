import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import {
  sanitizePrefix,
  createSkillMap,
  applyInvocationOverrides,
  getModelInvocableSkills,
  getUserInvocableSkills,
  generateInstructions,
  warnLargeSkillCount,
  discoverSkills,
  getResourceAnnotations,
  getSkillPath,
  buildSkillResourceUri,
  parseSkillResourceUri,
  buildSkillIndex,
  BUNDLED_SKILL_SOURCE,
  SKILL_COUNT_WARNING_THRESHOLD,
} from "./skill-discovery.js";
import { createTestSkill, createTestSource } from "./__test-helpers__/helpers.js";

// Path to fixtures
const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

describe("sanitizePrefix", () => {
  it("returns cleaned string for normal input", () => {
    expect(sanitizePrefix("my-project")).toBe("my-project");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizePrefix("my project")).toBe("my-project");
  });

  it("strips special characters", () => {
    expect(sanitizePrefix("my@project!")).toBe("myproject");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizePrefix("-foo-")).toBe("foo");
  });

  it("handles empty string", () => {
    expect(sanitizePrefix("")).toBe("");
  });

  it("handles all-special-character input", () => {
    expect(sanitizePrefix("@#$%")).toBe("");
  });

  it("preserves dots and underscores", () => {
    expect(sanitizePrefix("my.project_v2")).toBe("my.project_v2");
  });

  it("replaces each whitespace run with a hyphen", () => {
    expect(sanitizePrefix("my   project")).toBe("my-project");
  });
});

describe("createSkillMap", () => {
  it("creates map from array of skills", () => {
    const skills = [
      createTestSkill({ name: "skill-a" }),
      createTestSkill({ name: "skill-b" }),
    ];
    const map = createSkillMap(skills);
    expect(map.size).toBe(2);
    expect(map.get("skill-a")).toBeDefined();
    expect(map.get("skill-b")).toBeDefined();
  });

  it("returns empty map for empty array", () => {
    const map = createSkillMap([]);
    expect(map.size).toBe(0);
  });

  it("keeps first occurrence on duplicate names", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = createTestSkill({ name: "dup", path: "/first/SKILL.md" });
    const second = createTestSkill({ name: "dup", path: "/second/SKILL.md" });
    const map = createSkillMap([first, second]);
    expect(map.size).toBe(1);
    expect(map.get("dup")!.path).toBe("/first/SKILL.md");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate skill name"));
    consoleSpy.mockRestore();
  });

});

describe("applyInvocationOverrides", () => {
  it("returns unchanged skills when no overrides match", () => {
    const skills = [createTestSkill({ name: "a" })];
    const result = applyInvocationOverrides(skills, {});
    expect(result[0]).toBe(skills[0]); // Same reference
  });

  it("applies assistant override", () => {
    const skills = [createTestSkill({ name: "a", effectiveAssistantInvocable: true })];
    const result = applyInvocationOverrides(skills, { a: { assistant: false } });
    expect(result[0].effectiveAssistantInvocable).toBe(false);
    expect(result[0].isAssistantOverridden).toBe(true);
  });

  it("applies user override", () => {
    const skills = [createTestSkill({ name: "a", effectiveUserInvocable: true })];
    const result = applyInvocationOverrides(skills, { a: { user: false } });
    expect(result[0].effectiveUserInvocable).toBe(false);
    expect(result[0].isUserOverridden).toBe(true);
  });

  it("applies both assistant and user overrides", () => {
    const skills = [createTestSkill({ name: "a" })];
    const result = applyInvocationOverrides(skills, {
      a: { assistant: false, user: false },
    });
    expect(result[0].effectiveAssistantInvocable).toBe(false);
    expect(result[0].effectiveUserInvocable).toBe(false);
    expect(result[0].isAssistantOverridden).toBe(true);
    expect(result[0].isUserOverridden).toBe(true);
  });

  it("does not set override flags when no override exists", () => {
    const skills = [createTestSkill({ name: "a" }), createTestSkill({ name: "b" })];
    const result = applyInvocationOverrides(skills, { a: { assistant: false } });
    expect(result[1].isAssistantOverridden).toBe(false);
    expect(result[1].isUserOverridden).toBe(false);
  });
});

describe("getModelInvocableSkills", () => {
  it("filters out skills with effectiveAssistantInvocable false", () => {
    const skills = [
      createTestSkill({ name: "a", effectiveAssistantInvocable: true }),
      createTestSkill({ name: "b", effectiveAssistantInvocable: false }),
    ];
    const result = getModelInvocableSkills(skills);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("a");
  });
});

describe("getUserInvocableSkills", () => {
  it("filters out skills with effectiveUserInvocable false", () => {
    const skills = [
      createTestSkill({ name: "a", effectiveUserInvocable: true }),
      createTestSkill({ name: "b", effectiveUserInvocable: false }),
    ];
    const result = getUserInvocableSkills(skills);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("a");
  });
});

describe("generateInstructions", () => {
  it("generates XML with preamble for multiple skills", () => {
    const skills = [
      createTestSkill({ name: "skill-a", description: "Desc A", path: "/a/SKILL.md" }),
      createTestSkill({ name: "skill-b", description: "Desc B", path: "/b/SKILL.md" }),
    ];
    const result = generateInstructions(skills);
    expect(result).toContain("# Skills");
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>skill-a</name>");
    expect(result).toContain("<description>Desc A</description>");
    expect(result).toContain("<name>skill-b</name>");
    expect(result).toContain("</available_skills>");
  });

  it("returns empty available_skills when no skills", () => {
    const result = generateInstructions([]);
    expect(result).toContain("<available_skills>\n</available_skills>");
  });

  it("escapes XML special characters", () => {
    const skills = [
      createTestSkill({
        name: 'skill<>&"\'',
        description: 'Desc with <tags> & "quotes"',
        path: "/path/SKILL.md",
      }),
    ];
    const result = generateInstructions(skills);
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;");
    expect(result).toContain("&apos;");
  });

});

describe("warnLargeSkillCount", () => {
  it("logs warning when count >= threshold", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLargeSkillCount(SKILL_COUNT_WARNING_THRESHOLD);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${SKILL_COUNT_WARNING_THRESHOLD} skills discovered`)
    );
    consoleSpy.mockRestore();
  });

  it("does not log when count < threshold", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLargeSkillCount(SKILL_COUNT_WARNING_THRESHOLD - 1);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

});

describe("discoverSkills", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("discovers valid skills from a directory", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const names = skills.map((s) => s.baseName);
    expect(names).toContain("test-skill");
    expect(names).toContain("minimal");
    expect(names).toContain("lowercase");
    expect(names).toContain("disabled-model");
    expect(names).toContain("no-prompt");
    expect(names).toContain("resourceful");
  });

  it("returns empty array when directory does not exist", () => {
    const skills = discoverSkills("/nonexistent/path");
    expect(skills).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("skips directories without SKILL.md", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const names = skills.map((s) => s.baseName);
    expect(names).not.toContain("not-a-skill");
  });

  it("handles missing name field gracefully", () => {
    discoverSkills(FIXTURES_DIR);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("missing or invalid 'name'"));
  });

  it("handles missing description field gracefully", () => {
    discoverSkills(FIXTURES_DIR);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("missing or invalid 'description'")
    );
  });

  it("applies source prefix to qualified name", () => {
    const source = createTestSource({ prefix: "my-project" });
    const skills = discoverSkills(FIXTURES_DIR, source);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^my-project__/);
    }
  });

  it("sets disableModelInvocation correctly", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const disabled = skills.find((s) => s.baseName === "disabled-model");
    expect(disabled).toBeDefined();
    expect(disabled!.disableModelInvocation).toBe(true);
    expect(disabled!.effectiveAssistantInvocable).toBe(false);
  });

  it("sets userInvocable correctly", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const noPrompt = skills.find((s) => s.baseName === "no-prompt");
    expect(noPrompt).toBeDefined();
    expect(noPrompt!.userInvocable).toBe(false);
    expect(noPrompt!.effectiveUserInvocable).toBe(false);
  });
});

describe("getResourceAnnotations", () => {
  it("returns both audience roles when both flags are true", () => {
    const skill = createTestSkill({
      effectiveAssistantInvocable: true,
      effectiveUserInvocable: true,
    });
    const { annotations } = getResourceAnnotations(skill);
    expect(annotations.audience).toEqual(["assistant", "user"]);
    expect(annotations.priority).toBe(0.5);
  });

  it("returns only assistant when only assistantInvocable is true", () => {
    const skill = createTestSkill({
      effectiveAssistantInvocable: true,
      effectiveUserInvocable: false,
    });
    const { annotations } = getResourceAnnotations(skill);
    expect(annotations.audience).toEqual(["assistant"]);
  });

  it("returns only user when only userInvocable is true", () => {
    const skill = createTestSkill({
      effectiveAssistantInvocable: false,
      effectiveUserInvocable: true,
    });
    const { annotations } = getResourceAnnotations(skill);
    expect(annotations.audience).toEqual(["user"]);
  });

  it("returns empty audience when both flags are false", () => {
    const skill = createTestSkill({
      effectiveAssistantInvocable: false,
      effectiveUserInvocable: false,
    });
    const { annotations } = getResourceAnnotations(skill);
    expect(annotations.audience).toEqual([]);
  });

  it("uses default priority of 0.5", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill);
    expect(annotations.priority).toBe(0.5);
  });

  it("accepts custom priority", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, 0.8);
    expect(annotations.priority).toBe(0.8);
  });

  it("clamps priority below 0 to 0", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, -1);
    expect(annotations.priority).toBe(0);
  });

  it("clamps priority above 1 to 1", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, 5);
    expect(annotations.priority).toBe(1);
  });

  it("falls back to 0.5 for NaN priority", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, NaN);
    expect(annotations.priority).toBe(0.5);
  });

  it("falls back to 0.5 for Infinity priority", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, Infinity);
    expect(annotations.priority).toBe(0.5);
  });

  it("falls back to 0.5 for -Infinity priority", () => {
    const skill = createTestSkill();
    const { annotations } = getResourceAnnotations(skill, -Infinity);
    expect(annotations.priority).toBe(0.5);
  });

  it("includes lastModified and size for existing file paths", () => {
    // Use this test file itself as a real path
    const skill = createTestSkill({ path: __filename });
    const { annotations, size } = getResourceAnnotations(skill);
    expect(annotations.lastModified).toBeDefined();
    expect(new Date(annotations.lastModified!).getTime()).not.toBeNaN();
    expect(size).toBeGreaterThan(0);
  });

  it("omits lastModified and size when file path does not exist", () => {
    const skill = createTestSkill({ path: "/fake/path/SKILL.md" });
    const { annotations, size } = getResourceAnnotations(skill);
    expect(annotations.lastModified).toBeUndefined();
    expect(size).toBeUndefined();
  });
});

describe("getSkillPath (SEP-2640)", () => {
  it("returns baseName alone for bundled skills (empty prefix)", () => {
    const skill = createTestSkill({
      baseName: "git-workflow",
      source: BUNDLED_SKILL_SOURCE,
    });
    expect(getSkillPath(skill)).toBe("git-workflow");
  });

  it("returns prefix/baseName for prefixed skills", () => {
    const skill = createTestSkill({
      baseName: "commit",
      source: createTestSource({ prefix: "my-project" }),
    });
    expect(getSkillPath(skill)).toBe("my-project/commit");
  });

  it("sanitizes the prefix", () => {
    const skill = createTestSkill({
      baseName: "deploy",
      source: createTestSource({ prefix: "Hello World!" }),
    });
    expect(getSkillPath(skill)).toBe("Hello-World/deploy");
  });

  it("falls back to baseName when sanitized prefix is empty", () => {
    const skill = createTestSkill({
      baseName: "lone",
      source: createTestSource({ prefix: "@#$" }),
    });
    expect(getSkillPath(skill)).toBe("lone");
  });
});

describe("buildSkillResourceUri (SEP-2640)", () => {
  it("builds skill://baseName/SKILL.md for bundled skills", () => {
    const skill = createTestSkill({
      baseName: "git-workflow",
      source: BUNDLED_SKILL_SOURCE,
    });
    expect(buildSkillResourceUri(skill, "SKILL.md")).toBe(
      "skill://git-workflow/SKILL.md"
    );
  });

  it("builds skill://prefix/baseName/SKILL.md for prefixed skills", () => {
    const skill = createTestSkill({
      baseName: "refunds",
      source: createTestSource({ prefix: "acme-billing" }),
    });
    expect(buildSkillResourceUri(skill, "SKILL.md")).toBe(
      "skill://acme-billing/refunds/SKILL.md"
    );
  });

  it("preserves slashes between file path segments while encoding each segment", () => {
    const skill = createTestSkill({
      baseName: "pdf-processing",
      source: BUNDLED_SKILL_SOURCE,
    });
    expect(buildSkillResourceUri(skill, "scripts/extract.py")).toBe(
      "skill://pdf-processing/scripts/extract.py"
    );
  });

  it("percent-encodes spaces and special chars within a file segment", () => {
    const skill = createTestSkill({
      baseName: "docs",
      source: BUNDLED_SKILL_SOURCE,
    });
    expect(buildSkillResourceUri(skill, "templates/email subject.md")).toBe(
      "skill://docs/templates/email%20subject.md"
    );
  });
});

describe("parseSkillResourceUri (SEP-2640)", () => {
  const bundled = createTestSkill({
    baseName: "my-skill",
    name: "my-skill",
    path: "/skills/my-skill/SKILL.md",
    source: BUNDLED_SKILL_SOURCE,
  });
  const prefixed = createTestSkill({
    baseName: "refunds",
    name: "acme-billing__refunds",
    path: "/skills/refunds/SKILL.md",
    source: createTestSource({ prefix: "acme-billing" }),
  });
  const map = new Map([
    [bundled.name, bundled],
    [prefixed.name, prefixed],
  ]);

  it("resolves bundled SKILL.md URI", () => {
    const result = parseSkillResourceUri("skill://my-skill/SKILL.md", map);
    expect(result?.skill).toBe(bundled);
    expect(result?.fileRelPath).toBe("SKILL.md");
  });

  it("resolves prefixed SKILL.md URI", () => {
    const result = parseSkillResourceUri(
      "skill://acme-billing/refunds/SKILL.md",
      map
    );
    expect(result?.skill).toBe(prefixed);
    expect(result?.fileRelPath).toBe("SKILL.md");
  });

  it("resolves a nested supporting-file URI", () => {
    const result = parseSkillResourceUri(
      "skill://acme-billing/refunds/templates/email.md",
      map
    );
    expect(result?.skill).toBe(prefixed);
    expect(result?.fileRelPath).toBe("templates/email.md");
  });

  it("returns null for non-skill scheme", () => {
    expect(parseSkillResourceUri("http://example.com/x", map)).toBeNull();
  });

  it("returns null when no skill matches", () => {
    expect(parseSkillResourceUri("skill://nope/SKILL.md", map)).toBeNull();
  });

  it("returns null for a legacy bare skill://name URI (no file)", () => {
    expect(parseSkillResourceUri("skill://my-skill", map)).toBeNull();
  });

  it("returns null for a legacy skill://name/ URI (empty file segment)", () => {
    expect(parseSkillResourceUri("skill://my-skill/", map)).toBeNull();
  });
});

describe("buildSkillIndex (SEP-2640)", () => {
  it("emits the SEP $schema URL", () => {
    const map = new Map([
      ["a", createTestSkill({ name: "a", baseName: "a", source: BUNDLED_SKILL_SOURCE })],
    ]);
    expect(buildSkillIndex(map).$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
    );
  });

  it("emits one entry per skill with type skill-md and the SKILL.md URL", () => {
    const a = createTestSkill({
      name: "a",
      baseName: "a",
      description: "skill A",
      source: BUNDLED_SKILL_SOURCE,
    });
    const b = createTestSkill({
      name: "p__b",
      baseName: "b",
      description: "skill B",
      source: createTestSource({ prefix: "p" }),
    });
    const index = buildSkillIndex(
      new Map([
        [a.name, a],
        [b.name, b],
      ])
    );
    expect(index.skills).toHaveLength(2);
    expect(index.skills).toEqual(
      expect.arrayContaining([
        {
          name: "a",
          type: "skill-md",
          description: "skill A",
          url: "skill://a/SKILL.md",
        },
        {
          name: "b",
          type: "skill-md",
          description: "skill B",
          url: "skill://p/b/SKILL.md",
        },
      ])
    );
  });

  it("uses baseName, not the qualified name, for the index name field", () => {
    const skill = createTestSkill({
      name: "my-project__commit",
      baseName: "commit",
      source: createTestSource({ prefix: "my-project" }),
    });
    const index = buildSkillIndex(new Map([[skill.name, skill]]));
    expect(index.skills[0].name).toBe("commit");
  });
});
