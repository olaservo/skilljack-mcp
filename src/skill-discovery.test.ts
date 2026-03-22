import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import {
  sanitizePrefix,
  validateMetaKey,
  createSkillMap,
  applyInvocationOverrides,
  getModelInvocableSkills,
  getUserInvocableSkills,
  generateInstructions,
  warnLargeSkillCount,
  discoverSkills,
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

describe("validateMetaKey", () => {
  it("accepts valid simple name", () => {
    expect(validateMetaKey("version")).toEqual({ valid: true });
  });

  it("accepts valid name with dots and hyphens", () => {
    expect(validateMetaKey("my-key.v1")).toEqual({ valid: true });
  });

  it("accepts valid prefixed key", () => {
    const result = validateMetaKey("com.example/version");
    expect(result.valid).toBe(true);
    expect(result.reserved).toBeUndefined();
  });

  it("accepts prefix with empty name", () => {
    const result = validateMetaKey("com.example/");
    expect(result.valid).toBe(true);
  });

  it("rejects empty key", () => {
    expect(validateMetaKey("")).toEqual({ valid: false, reason: "key is empty" });
  });

  it("rejects name starting with hyphen", () => {
    const result = validateMetaKey("-bad");
    expect(result.valid).toBe(false);
  });

  it("rejects name ending with hyphen", () => {
    const result = validateMetaKey("bad-");
    expect(result.valid).toBe(false);
  });

  it("rejects name with special characters", () => {
    const result = validateMetaKey("bad key!");
    expect(result.valid).toBe(false);
  });

  it("rejects invalid prefix label starting with digit", () => {
    const result = validateMetaKey("1com.example/key");
    expect(result.valid).toBe(false);
  });

  it("rejects invalid prefix label ending with hyphen", () => {
    const result = validateMetaKey("com-.example/key");
    expect(result.valid).toBe(false);
  });

  it("flags reserved prefix with modelcontextprotocol", () => {
    const result = validateMetaKey("io.modelcontextprotocol/key");
    expect(result.valid).toBe(true);
    expect(result.reserved).toBe(true);
  });

  it("flags reserved prefix with mcp", () => {
    const result = validateMetaKey("dev.mcp/key");
    expect(result.valid).toBe(true);
    expect(result.reserved).toBe(true);
  });

  it("does not flag mcp in third position as reserved", () => {
    const result = validateMetaKey("com.example.mcp/key");
    expect(result.valid).toBe(true);
    expect(result.reserved).toBeUndefined();
  });

  it("rejects empty prefix label", () => {
    const result = validateMetaKey(".example/key");
    expect(result.valid).toBe(false);
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
    expect(names).toContain("meta-skill");
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

  it("parses valid metadata keys", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const metaSkill = skills.find((s) => s.baseName === "meta-skill");
    expect(metaSkill).toBeDefined();
    expect(metaSkill!.metadata).toEqual({
      "com.example/version": "1.0",
      author: "test",
    });
  });

  it("skips invalid metadata keys with warning", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const badMeta = skills.find((s) => s.baseName === "bad-meta");
    expect(badMeta).toBeDefined();
    expect(badMeta!.metadata).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("skipping metadata key"));
  });

  it("skips reserved metadata keys with warning", () => {
    const skills = discoverSkills(FIXTURES_DIR);
    const reservedMeta = skills.find((s) => s.baseName === "reserved-meta");
    expect(reservedMeta).toBeDefined();
    expect(reservedMeta!.metadata).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reserved"));
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
