import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { getToolDescription, isPathWithinBase, listSkillFiles } from "./skill-tool.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";

// Path to fixtures
const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

describe("getToolDescription", () => {
  it("includes skill list for model-invocable skills", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "my-skill", description: "Does things", effectiveAssistantInvocable: true }),
    ]);
    const desc = getToolDescription(state);
    expect(desc).toContain("Load a skill");
    expect(desc).toContain("<name>my-skill</name>");
    expect(desc).toContain("<description>Does things</description>");
  });

  it("excludes skills with effectiveAssistantInvocable false", () => {
    const state = createTestSkillState([
      createTestSkill({ name: "visible", effectiveAssistantInvocable: true }),
      createTestSkill({ name: "hidden", effectiveAssistantInvocable: false }),
    ]);
    const desc = getToolDescription(state);
    expect(desc).toContain("<name>visible</name>");
    expect(desc).not.toContain("<name>hidden</name>");
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
