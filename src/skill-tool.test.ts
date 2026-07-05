import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { getToolDescription, getServerInstructions, isPathWithinBase, listSkillFiles } from "./skill-tool.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";

// Path to fixtures
const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

describe("getToolDescription", () => {
  it("includes skill list for model-invocable skills in tool-description mode", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "my-skill", description: "Does things", effectiveAssistantInvocable: true }),
    ]);
    const desc = getToolDescription(state, "tool-description");
    expect(desc).toContain("Load a skill");
    expect(desc).toContain("<name>my-skill</name>");
    expect(desc).toContain("<description>Does things</description>");
  });

  it("excludes skills with effectiveAssistantInvocable false", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "visible", effectiveAssistantInvocable: true }),
      createTestSkill({ name: "hidden", effectiveAssistantInvocable: false }),
    ]);
    const desc = getToolDescription(state, "tool-description");
    expect(desc).toContain("<name>visible</name>");
    expect(desc).not.toContain("<name>hidden</name>");
  });

  it("omits the skill list in instructions mode (the default) but keeps usage guidance", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "my-skill", effectiveAssistantInvocable: true }),
    ]);
    for (const desc of [getToolDescription(state, "instructions"), getToolDescription(state)]) {
      expect(desc).toContain("Load a skill");
      expect(desc).not.toContain("<available_skills>");
      expect(desc).not.toContain("<name>my-skill</name>");
    }
  });
});

describe("getServerInstructions", () => {
  const state = () =>
    createTestSkillState([
      createTestSkill({ name: "my-skill", description: "Does things", effectiveAssistantInvocable: true }),
    ]);

  it("returns undefined in tool-description mode", () => {
    expect(getServerInstructions(state(), "tool-description")).toBeUndefined();
  });

  it("returns usage preamble + catalog in instructions mode (the default)", () => {
    for (const instructions of [getServerInstructions(state(), "instructions"), getServerInstructions(state())]) {
      expect(instructions).toContain("`load-skill`");
      expect(instructions).toContain("<name>my-skill</name>");
      expect(instructions).toContain("<description>Does things</description>");
    }
  });

  it("filters non-model-invocable skills", () => {
    const mixed = createTestSkillState([
      createTestSkill({ name: "visible", effectiveAssistantInvocable: true }),
      createTestSkill({ name: "hidden", effectiveAssistantInvocable: false }),
    ]);
    const instructions = getServerInstructions(mixed, "instructions");
    expect(instructions).toContain("<name>visible</name>");
    expect(instructions).not.toContain("<name>hidden</name>");
  });
});

describe("isPathWithinBase", () => {
  it("returns true for path within base directory", () => {
    // Use real filesystem paths that exist
    const base = FIXTURES_DIR;
    const target = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    expect(isPathWithinBase(target, base)).toBe(true);
  });

  it("returns true for path equal to base directory", () => {
    expect(isPathWithinBase(FIXTURES_DIR, FIXTURES_DIR)).toBe(true);
  });

  it("returns false for path traversal", () => {
    const base = path.join(FIXTURES_DIR, "valid-skill");
    const target = path.join(FIXTURES_DIR, "valid-skill", "..", "..", "package.json");
    expect(isPathWithinBase(target, base)).toBe(false);
  });

  it("returns false for sibling directory", () => {
    const base = path.join(FIXTURES_DIR, "valid-skill");
    const target = path.join(FIXTURES_DIR, "minimal-skill", "SKILL.md");
    expect(isPathWithinBase(target, base)).toBe(false);
  });

  it("handles non-existent paths via fallback", () => {
    const base = "/some/base/dir";
    const target = "/some/base/dir/subfile.txt";
    // realpathSync will fail for non-existent paths, falls back to resolve check
    expect(isPathWithinBase(target, base)).toBe(true);
  });

  it("rejects non-existent path traversal via fallback", () => {
    const base = "/some/base/dir";
    const target = "/some/other/dir/file.txt";
    expect(isPathWithinBase(target, base)).toBe(false);
  });

  it("returns true when non-existent path equals base via fallback", () => {
    const dir = "/nonexistent/base/dir";
    expect(isPathWithinBase(dir, dir)).toBe(true);
  });
});

describe("listSkillFiles", () => {
  it("lists files recursively excluding SKILL.md", () => {
    const skillDir = path.join(FIXTURES_DIR, "with-resources");
    const files = listSkillFiles(skillDir);
    expect(files).toContain("scripts/example.py");
    expect(files).toContain("templates/config.json");
    expect(files).not.toContain("SKILL.md");
  });

  it("returns empty array for non-existent directory", () => {
    expect(listSkillFiles("/nonexistent/path")).toEqual([]);
  });

  it("returns empty array when only SKILL.md exists", () => {
    const skillDir = path.join(FIXTURES_DIR, "valid-skill");
    const files = listSkillFiles(skillDir);
    expect(files).toHaveLength(0);
  });

  it("returns empty array when depth exceeds MAX_DIRECTORY_DEPTH", () => {
    const files = listSkillFiles(FIXTURES_DIR, "", 11);
    expect(files).toEqual([]);
  });

  it("handles subPath parameter", () => {
    const skillDir = path.join(FIXTURES_DIR, "with-resources");
    const files = listSkillFiles(skillDir, "scripts");
    expect(files).toContain("scripts/example.py");
    expect(files).not.toContain("templates/config.json");
  });
});
