import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveUriToFilePaths } from "./subscriptions.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";

describe("resolveUriToFilePaths", () => {
  const skill1 = createTestSkill({
    name: "my-skill",
    path: "/skills/my-skill/SKILL.md",
  });
  const skill2 = createTestSkill({
    name: "other-skill",
    path: "/skills/other-skill/SKILL.md",
  });
  const state = createTestSkillState([skill1, skill2]);

  it("resolves skill:// to all skill directory paths", () => {
    const paths = resolveUriToFilePaths("skill://", state);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(path.dirname(skill1.path));
    expect(paths).toContain(path.dirname(skill2.path));
  });

  it("resolves skill://name to SKILL.md path", () => {
    const paths = resolveUriToFilePaths("skill://my-skill", state);
    expect(paths).toEqual(["/skills/my-skill/SKILL.md"]);
  });

  it("resolves skill://name/ to skill directory path", () => {
    const paths = resolveUriToFilePaths("skill://my-skill/", state);
    expect(paths).toEqual([path.dirname(skill1.path)]);
  });

  it("resolves skill://name/path to absolute file path", () => {
    const paths = resolveUriToFilePaths("skill://my-skill/scripts/example.py", state);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(path.resolve("/skills/my-skill", "scripts/example.py"));
  });

  it("returns empty array for unknown skill name", () => {
    const paths = resolveUriToFilePaths("skill://nonexistent", state);
    expect(paths).toEqual([]);
  });

  it("returns empty array for unmatched URI patterns", () => {
    const paths = resolveUriToFilePaths("http://example.com", state);
    expect(paths).toEqual([]);
  });
});
