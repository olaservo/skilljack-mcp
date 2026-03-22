import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  isGitHubUrl,
  parseGitHubUrl,
  isRepoAllowed,
  getRepoCachePath,
  getRepoClonePath,
  GitHubConfig,
  GitHubRepoSpec,
} from "./github-config.js";

describe("isGitHubUrl", () => {
  it("returns true for https://github.com URL", () => {
    expect(isGitHubUrl("https://github.com/owner/repo")).toBe(true);
  });

  it("returns true for github.com without protocol", () => {
    expect(isGitHubUrl("github.com/owner/repo")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isGitHubUrl("GITHUB.COM/owner/repo")).toBe(true);
    expect(isGitHubUrl("GitHub.com/Owner/Repo")).toBe(true);
  });

  it("returns false for local path", () => {
    expect(isGitHubUrl("/local/path")).toBe(false);
    expect(isGitHubUrl("C:\\Users\\project")).toBe(false);
  });

  it("returns false for gitlab URL", () => {
    expect(isGitHubUrl("gitlab.com/owner/repo")).toBe(false);
  });

});

describe("parseGitHubUrl", () => {
  it("parses basic owner/repo", () => {
    const result = parseGitHubUrl("github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("strips protocol prefix", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("strips .git suffix", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses @ref", () => {
    const result = parseGitHubUrl("github.com/owner/repo@main");
    expect(result).toEqual({ owner: "owner", repo: "repo", ref: "main" });
  });

  it("parses /subpath", () => {
    const result = parseGitHubUrl("github.com/owner/repo/subpath");
    expect(result).toEqual({ owner: "owner", repo: "repo", subpath: "subpath" });
  });

  it("parses /subpath@ref", () => {
    const result = parseGitHubUrl("github.com/owner/repo/subpath@v1.0");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      subpath: "subpath",
      ref: "v1.0",
    });
  });

  it("parses web URL with /tree/ref/path", () => {
    const result = parseGitHubUrl("github.com/owner/repo/tree/main/path/to/dir");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "path/to/dir",
    });
  });

  it("parses web URL with /blob/ref/path", () => {
    const result = parseGitHubUrl("github.com/owner/repo/blob/main/file.md");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "file.md",
    });
  });

  it("throws on missing repo", () => {
    expect(() => parseGitHubUrl("github.com/owner")).toThrow("Invalid GitHub URL");
  });

  it("throws on empty path", () => {
    expect(() => parseGitHubUrl("github.com/")).toThrow("Invalid GitHub URL");
  });

  it("handles nested subpath", () => {
    const result = parseGitHubUrl("github.com/owner/repo/a/b/c");
    expect(result).toEqual({ owner: "owner", repo: "repo", subpath: "a/b/c" });
  });

  it("uses last @ for ref when multiple exist", () => {
    const result = parseGitHubUrl("github.com/owner/repo@first@second");
    expect(result.ref).toBe("second");
  });

  it("handles /tree/ with ref but no subpath", () => {
    const result = parseGitHubUrl("github.com/owner/repo/tree/main");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
    });
  });
});

describe("isRepoAllowed", () => {
  const baseConfig: GitHubConfig = {
    pollIntervalMs: 300000,
    cacheDir: "/cache",
    allowedOrgs: [],
    allowedUsers: [],
  };

  it("returns false when no allowlist configured", () => {
    const spec: GitHubRepoSpec = { owner: "anyone", repo: "anything" };
    expect(isRepoAllowed(spec, baseConfig)).toBe(false);
  });

  it("returns true when owner is in allowedOrgs", () => {
    const config = { ...baseConfig, allowedOrgs: ["myorg"] };
    const spec: GitHubRepoSpec = { owner: "myorg", repo: "repo" };
    expect(isRepoAllowed(spec, config)).toBe(true);
  });

  it("returns true when owner is in allowedUsers", () => {
    const config = { ...baseConfig, allowedUsers: ["myuser"] };
    const spec: GitHubRepoSpec = { owner: "myuser", repo: "repo" };
    expect(isRepoAllowed(spec, config)).toBe(true);
  });

  it("matches case-insensitively for orgs", () => {
    const config = { ...baseConfig, allowedOrgs: ["MyOrg"] };
    const spec: GitHubRepoSpec = { owner: "myorg", repo: "repo" };
    expect(isRepoAllowed(spec, config)).toBe(true);
  });

  it("matches case-insensitively for users", () => {
    const config = { ...baseConfig, allowedUsers: ["MyUser"] };
    const spec: GitHubRepoSpec = { owner: "MYUSER", repo: "repo" };
    expect(isRepoAllowed(spec, config)).toBe(true);
  });

  it("returns false when owner not in any list", () => {
    const config = { ...baseConfig, allowedOrgs: ["org1"], allowedUsers: ["user1"] };
    const spec: GitHubRepoSpec = { owner: "stranger", repo: "repo" };
    expect(isRepoAllowed(spec, config)).toBe(false);
  });
});

describe("getRepoCachePath", () => {
  it("includes subpath in returned path", () => {
    const spec: GitHubRepoSpec = { owner: "owner", repo: "repo", subpath: "sub/dir" };
    const result = getRepoCachePath(spec, "/cache");
    expect(result).toBe(path.join("/cache", "owner", "repo", "sub", "dir"));
  });
});

describe("getRepoClonePath", () => {
  it("ignores subpath and returns repo root", () => {
    const spec: GitHubRepoSpec = { owner: "owner", repo: "repo", subpath: "sub/dir" };
    const result = getRepoClonePath(spec, "/cache");
    expect(result).toBe(path.join("/cache", "owner", "repo"));
  });
});
