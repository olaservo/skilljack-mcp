import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveUriToFilePaths } from "./subscriptions.js";
import { BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";
import {
  createTestSkill,
  createTestSkillState,
  createTestSource,
} from "./__test-helpers__/helpers.js";

describe("resolveUriToFilePaths (SEP-2640)", () => {
  const bundled = createTestSkill({
    name: "my-skill",
    baseName: "my-skill",
    path: "/skills/my-skill/SKILL.md",
    source: BUNDLED_SKILL_SOURCE,
  });
  const prefixed = createTestSkill({
    name: "my-project__other-skill",
    baseName: "other-skill",
    path: "/skills/other-skill/SKILL.md",
    source: createTestSource({ prefix: "my-project" }),
  });
  const state = createTestSkillState([bundled, prefixed]);

  it("resolves skill://index.json to every SKILL.md path", () => {
    const paths = resolveUriToFilePaths("skill://index.json", state);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(bundled.path);
    expect(paths).toContain(prefixed.path);
  });

  it("resolves skill://<base>/SKILL.md (bundled) to that SKILL.md", () => {
    const paths = resolveUriToFilePaths("skill://my-skill/SKILL.md", state);
    expect(paths).toEqual([bundled.path]);
  });

  it("resolves skill://<prefix>/<base>/SKILL.md to that SKILL.md", () => {
    const paths = resolveUriToFilePaths(
      "skill://my-project/other-skill/SKILL.md",
      state
    );
    expect(paths).toEqual([prefixed.path]);
  });

  it("resolves skill://<path>/<file> to absolute file path", () => {
    const paths = resolveUriToFilePaths(
      "skill://my-skill/scripts/example.py",
      state
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(path.resolve("/skills/my-skill", "scripts/example.py"));
  });

  it("rejects path traversal", () => {
    const paths = resolveUriToFilePaths(
      "skill://my-skill/..%2F..%2Fetc%2Fpasswd",
      state
    );
    expect(paths).toEqual([]);
  });

  it("returns [] for unknown skill", () => {
    const paths = resolveUriToFilePaths("skill://nonexistent/SKILL.md", state);
    expect(paths).toEqual([]);
  });

  it("returns [] for legacy bare skill://name URI", () => {
    expect(resolveUriToFilePaths("skill://my-skill", state)).toEqual([]);
  });

  it("returns [] for legacy skill://name/ URI", () => {
    expect(resolveUriToFilePaths("skill://my-skill/", state)).toEqual([]);
  });

  it("returns [] for non-skill scheme", () => {
    expect(resolveUriToFilePaths("http://example.com", state)).toEqual([]);
  });
});
