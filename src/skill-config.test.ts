import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { parseCLIArgs, parseEnvVar } from "./skill-config.js";

describe("parseCLIArgs", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("returns empty array when no positional args", () => {
    process.argv = ["node", "script.js"];
    expect(parseCLIArgs()).toEqual([]);
  });

  it("returns resolved paths from positional args", () => {
    process.argv = ["node", "script.js", "/absolute/path"];
    const result = parseCLIArgs();
    expect(result).toEqual([path.resolve("/absolute/path")]);
  });

  it("skips flags starting with -", () => {
    process.argv = ["node", "script.js", "--static", "/my/path"];
    const result = parseCLIArgs();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.resolve("/my/path"));
  });

  it("splits comma-separated values", () => {
    process.argv = ["node", "script.js", "/path1,/path2"];
    const result = parseCLIArgs();
    expect(result).toHaveLength(2);
    expect(result).toContain(path.resolve("/path1"));
    expect(result).toContain(path.resolve("/path2"));
  });

  it("deduplicates paths", () => {
    process.argv = ["node", "script.js", "/same/path", "/same/path"];
    const result = parseCLIArgs();
    expect(result).toHaveLength(1);
  });

  it("preserves GitHub URLs as-is", () => {
    process.argv = ["node", "script.js", "github.com/owner/repo"];
    const result = parseCLIArgs();
    expect(result).toEqual(["github.com/owner/repo"]);
  });
});

describe("parseEnvVar", () => {
  const originalEnv = process.env.SKILLS_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SKILLS_DIR;
    } else {
      process.env.SKILLS_DIR = originalEnv;
    }
  });

  it("returns empty array when SKILLS_DIR not set", () => {
    delete process.env.SKILLS_DIR;
    expect(parseEnvVar()).toEqual([]);
  });

  it("returns resolved path from single value", () => {
    process.env.SKILLS_DIR = "/my/skills";
    const result = parseEnvVar();
    expect(result).toEqual([path.resolve("/my/skills")]);
  });

  it("splits comma-separated paths", () => {
    process.env.SKILLS_DIR = "/path1,/path2";
    const result = parseEnvVar();
    expect(result).toHaveLength(2);
    expect(result).toContain(path.resolve("/path1"));
    expect(result).toContain(path.resolve("/path2"));
  });

  it("preserves GitHub URLs as-is", () => {
    process.env.SKILLS_DIR = "github.com/owner/repo";
    const result = parseEnvVar();
    expect(result).toEqual(["github.com/owner/repo"]);
  });

  it("trims whitespace around paths", () => {
    process.env.SKILLS_DIR = " /path1 , /path2 ";
    const result = parseEnvVar();
    expect(result).toHaveLength(2);
    expect(result).toContain(path.resolve("/path1"));
    expect(result).toContain(path.resolve("/path2"));
  });

  it("filters empty segments", () => {
    process.env.SKILLS_DIR = "/path1,,/path2";
    const result = parseEnvVar();
    expect(result).toHaveLength(2);
  });

  it("returns empty array when SKILLS_DIR is only whitespace", () => {
    process.env.SKILLS_DIR = "   ";
    const result = parseEnvVar();
    expect(result).toEqual([]);
  });
});
