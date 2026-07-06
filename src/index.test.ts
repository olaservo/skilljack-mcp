import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

// Must mock modules before importing the module under test
vi.mock("./skill-config.js", () => ({
  getActiveDirectories: vi.fn().mockReturnValue([]),
  getSkillInvocationOverrides: vi.fn().mockReturnValue({}),
  getStaticModeFromConfig: vi.fn().mockReturnValue(false),
}));

// Import after mocking
import { classifyPaths, getStaticMode, getCatalogMode, warnIfLegacyCatalogMode } from "./index.js";
import { getStaticModeFromConfig } from "./skill-config.js";

describe("classifyPaths", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("separates local paths and GitHub URLs", () => {
    const result = classifyPaths(["/local/path", "github.com/owner/repo"]);
    expect(result.localDirs).toHaveLength(1);
    expect(result.localDirs[0]).toBe(path.resolve("/local/path"));
    expect(result.githubSpecs).toHaveLength(1);
    expect(result.githubSpecs[0].owner).toBe("owner");
    expect(result.githubSpecs[0].repo).toBe("repo");
  });

  it("deduplicates local paths", () => {
    const result = classifyPaths(["/same/path", "/same/path"]);
    expect(result.localDirs).toHaveLength(1);
  });

  it("deduplicates GitHub specs by owner/repo", () => {
    const result = classifyPaths([
      "github.com/owner/repo",
      "github.com/owner/repo@main",
    ]);
    expect(result.githubSpecs).toHaveLength(1);
  });

  it("logs warning for invalid GitHub URLs", () => {
    const result = classifyPaths(["github.com/only-owner"]);
    expect(result.githubSpecs).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid GitHub URL"));
  });

});

describe("getStaticMode", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.SKILLJACK_STATIC;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) {
      delete process.env.SKILLJACK_STATIC;
    } else {
      process.env.SKILLJACK_STATIC = originalEnv;
    }
    vi.mocked(getStaticModeFromConfig).mockReturnValue(false);
  });

  it("returns true when --static in argv", () => {
    process.argv = ["node", "script.js", "--static"];
    expect(getStaticMode()).toBe(true);
  });

  it("returns true when SKILLJACK_STATIC=true", () => {
    process.argv = ["node", "script.js"];
    process.env.SKILLJACK_STATIC = "true";
    expect(getStaticMode()).toBe(true);
  });

  it("returns true when SKILLJACK_STATIC=1", () => {
    process.argv = ["node", "script.js"];
    process.env.SKILLJACK_STATIC = "1";
    expect(getStaticMode()).toBe(true);
  });

  it("returns true when SKILLJACK_STATIC=yes", () => {
    process.argv = ["node", "script.js"];
    process.env.SKILLJACK_STATIC = "yes";
    expect(getStaticMode()).toBe(true);
  });

  it("returns false when none are set and config is false", () => {
    process.argv = ["node", "script.js"];
    delete process.env.SKILLJACK_STATIC;
    vi.mocked(getStaticModeFromConfig).mockReturnValue(false);
    expect(getStaticMode()).toBe(false);
  });

  it("falls back to config file when no CLI or env", () => {
    process.argv = ["node", "script.js"];
    delete process.env.SKILLJACK_STATIC;
    vi.mocked(getStaticModeFromConfig).mockReturnValue(true);
    expect(getStaticMode()).toBe(true);
  });

  it("is case insensitive for env var", () => {
    process.argv = ["node", "script.js"];
    process.env.SKILLJACK_STATIC = "TRUE";
    expect(getStaticMode()).toBe(true);
  });
});

describe("getCatalogMode", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.SKILLJACK_CATALOG;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) {
      delete process.env.SKILLJACK_CATALOG;
    } else {
      process.env.SKILLJACK_CATALOG = originalEnv;
    }
  });

  it("defaults to instructions when nothing is set", () => {
    process.argv = ["node", "script.js"];
    delete process.env.SKILLJACK_CATALOG;
    expect(getCatalogMode()).toBe("instructions");
  });

  it("reads --catalog=instructions from argv", () => {
    process.argv = ["node", "script.js", "--catalog=instructions"];
    expect(getCatalogMode()).toBe("instructions");
  });

  it("reads --catalog=tool-description from argv", () => {
    process.argv = ["node", "script.js", "--catalog=tool-description"];
    expect(getCatalogMode()).toBe("tool-description");
  });

  it("reads SKILLJACK_CATALOG env var", () => {
    process.argv = ["node", "script.js"];
    process.env.SKILLJACK_CATALOG = "instructions";
    expect(getCatalogMode()).toBe("instructions");
  });

  it("prefers CLI flag over env var", () => {
    process.argv = ["node", "script.js", "--catalog=tool-description"];
    process.env.SKILLJACK_CATALOG = "instructions";
    expect(getCatalogMode()).toBe("tool-description");
  });

  it("is case insensitive", () => {
    process.argv = ["node", "script.js", "--catalog=INSTRUCTIONS"];
    expect(getCatalogMode()).toBe("instructions");
  });

  it("warns and falls back to instructions on unknown values", () => {
    process.argv = ["node", "script.js", "--catalog=both"];
    expect(getCatalogMode()).toBe("instructions");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown catalog mode"));
  });
});

describe("warnIfLegacyCatalogMode", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("warns on stderr for tool-description mode", () => {
    warnIfLegacyCatalogMode("tool-description");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("legacy escape hatch and not recommended")
    );
  });

  it("stays silent for instructions mode", () => {
    warnIfLegacyCatalogMode("instructions");
    expect(console.error).not.toHaveBeenCalled();
  });
});
