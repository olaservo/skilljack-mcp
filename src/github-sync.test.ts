import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { syncRepo, syncAllRepos, SyncOptions } from "./github-sync.js";
import { GitHubRepoSpec } from "./github-config.js";

// Mock simple-git
const mockGitInstance = {
  clone: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  fetch: vi.fn().mockResolvedValue(undefined),
  checkout: vi.fn().mockResolvedValue(undefined),
  revparse: vi.fn().mockResolvedValue("abc123"),
  tags: vi.fn().mockResolvedValue({ all: [] }),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockGitInstance),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
  };
});

describe("syncRepo", () => {
  const spec: GitHubRepoSpec = { owner: "test-owner", repo: "test-repo" };
  const options: SyncOptions = { cacheDir: "/cache" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Suppress console.error during tests
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("clones when repo does not exist", async () => {
    // .git directory doesn't exist -> needs cloning
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await syncRepo(spec, options);

    expect(result.updated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      expect.stringContaining("github.com/test-owner/test-repo"),
      expect.any(String),
      expect.arrayContaining(["--depth", "1"])
    );
  });

  it("pulls when repo already exists", async () => {
    // .git directory exists -> pull instead of clone
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pathStr = String(p);
      return pathStr.endsWith(".git");
    });
    mockGitInstance.revparse
      .mockResolvedValueOnce("before-head")
      .mockResolvedValueOnce("after-head");

    const result = await syncRepo(spec, options);

    expect(result.updated).toBe(true);
    expect(mockGitInstance.clone).not.toHaveBeenCalled();
  });

  it("skips pull for commit hash refs", async () => {
    const pinnedSpec: GitHubRepoSpec = {
      owner: "test-owner",
      repo: "test-repo",
      ref: "abc1234",
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pathStr = String(p);
      return pathStr.endsWith(".git");
    });
    mockGitInstance.tags.mockResolvedValue({ all: [] });

    const result = await syncRepo(pinnedSpec, options);

    expect(result.updated).toBe(false);
    expect(mockGitInstance.pull).not.toHaveBeenCalled();
  });

  it("skips pull for tag refs", async () => {
    const tagSpec: GitHubRepoSpec = {
      owner: "test-owner",
      repo: "test-repo",
      ref: "v1.0.0",
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pathStr = String(p);
      return pathStr.endsWith(".git");
    });
    mockGitInstance.tags.mockResolvedValue({ all: ["v1.0.0", "v2.0.0"] });

    const result = await syncRepo(tagSpec, options);

    expect(result.updated).toBe(false);
    expect(mockGitInstance.pull).not.toHaveBeenCalled();
  });

  it("returns error for auth failures", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockGitInstance.clone.mockRejectedValue(new Error("Authentication failed"));

    const result = await syncRepo(spec, options);

    expect(result.error).toContain("Authentication failed");
  });

  it("returns error for 404s", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockGitInstance.clone.mockRejectedValue(new Error("not found (404)"));

    const result = await syncRepo(spec, options);

    expect(result.error).toContain("not found");
  });

});

describe("syncAllRepos", () => {
  const options: SyncOptions = { cacheDir: "/cache" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("syncs multiple repos sequentially", async () => {
    const specs: GitHubRepoSpec[] = [
      { owner: "owner1", repo: "repo1" },
      { owner: "owner2", repo: "repo2" },
    ];

    const results = await syncAllRepos(specs, options);

    expect(results).toHaveLength(2);
    expect(results[0].spec.owner).toBe("owner1");
    expect(results[1].spec.owner).toBe("owner2");
  });

});
