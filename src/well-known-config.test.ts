import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  isWellKnownUrl,
  parseWellKnownUrl,
  isOriginAllowed,
  assertUrlAllowed,
  getWellKnownCacheKey,
  getWellKnownCachePath,
  getWellKnownIndexUrl,
  resolveArtifactUrl,
  WellKnownConfig,
} from "./well-known-config.js";

describe("isWellKnownUrl", () => {
  it("returns true for https://example.com URL", () => {
    expect(isWellKnownUrl("https://example.com")).toBe(true);
    expect(isWellKnownUrl("https://example.com/.well-known/agent-skills/")).toBe(true);
  });

  it("returns false for github URLs", () => {
    expect(isWellKnownUrl("https://github.com/owner/repo")).toBe(false);
    expect(isWellKnownUrl("github.com/owner/repo")).toBe(false);
  });

  it("returns false for local paths", () => {
    expect(isWellKnownUrl("/local/path")).toBe(false);
    expect(isWellKnownUrl("C:\\Users\\project")).toBe(false);
    expect(isWellKnownUrl("./relative")).toBe(false);
  });

  it("returns false for non-http schemes", () => {
    expect(isWellKnownUrl("ftp://example.com")).toBe(false);
    expect(isWellKnownUrl("file:///tmp/foo")).toBe(false);
  });

  it("returns true for http when present (parser still gates by allowHttp)", () => {
    expect(isWellKnownUrl("http://example.com")).toBe(true);
  });
});

describe("parseWellKnownUrl", () => {
  it("auto-appends /.well-known/agent-skills when missing", () => {
    const spec = parseWellKnownUrl("https://example.com");
    expect(spec.origin).toBe("https://example.com");
    expect(spec.basePath).toBe("/.well-known/agent-skills");
  });

  it("preserves existing /.well-known/agent-skills path", () => {
    const spec = parseWellKnownUrl("https://example.com/.well-known/agent-skills");
    expect(spec.basePath).toBe("/.well-known/agent-skills");
  });

  it("strips trailing /index.json", () => {
    const spec = parseWellKnownUrl(
      "https://example.com/.well-known/agent-skills/index.json"
    );
    expect(spec.basePath).toBe("/.well-known/agent-skills");
  });

  it("strips trailing slashes", () => {
    const spec = parseWellKnownUrl("https://example.com/.well-known/agent-skills/");
    expect(spec.basePath).toBe("/.well-known/agent-skills");
  });

  it("preserves a path prefix before /.well-known/agent-skills", () => {
    const spec = parseWellKnownUrl(
      "https://example.com/some/prefix/.well-known/agent-skills"
    );
    expect(spec.basePath).toBe("/some/prefix/.well-known/agent-skills");
  });

  it("includes port in origin", () => {
    const spec = parseWellKnownUrl("https://example.com:8443");
    expect(spec.origin).toBe("https://example.com:8443");
  });

  it("rejects http:// without allowHttp", () => {
    expect(() => parseWellKnownUrl("http://example.com")).toThrow(/Insecure scheme/);
  });

  it("accepts http:// when allowHttp = true", () => {
    const spec = parseWellKnownUrl("http://localhost:8080", true);
    expect(spec.origin).toBe("http://localhost:8080");
  });

  it("rejects unsupported schemes", () => {
    expect(() => parseWellKnownUrl("ftp://example.com")).toThrow(/Unsupported scheme/);
  });

  it("rejects malformed URLs", () => {
    expect(() => parseWellKnownUrl("not a url")).toThrow(/Invalid well-known URL/);
  });
});

describe("isOriginAllowed", () => {
  const baseConfig: WellKnownConfig = {
    pollIntervalMs: 0,
    cacheDir: "/tmp",
    allowedOrigins: [],
    maxArtifactBytes: 1,
    maxUnpackedBytes: 1,
    allowHttp: false,
  };

  it("denies all when allowlist is empty (default-deny)", () => {
    expect(
      isOriginAllowed(
        { origin: "https://example.com", basePath: "/.well-known/agent-skills" },
        baseConfig
      )
    ).toBe(false);
  });

  it("allows exact origin match", () => {
    const config = { ...baseConfig, allowedOrigins: ["https://example.com"] };
    expect(
      isOriginAllowed(
        { origin: "https://example.com", basePath: "/.well-known/agent-skills" },
        config
      )
    ).toBe(true);
  });

  it("is case insensitive on origin", () => {
    const config = { ...baseConfig, allowedOrigins: ["https://EXAMPLE.com"] };
    expect(
      isOriginAllowed(
        { origin: "https://example.com", basePath: "/.well-known/agent-skills" },
        config
      )
    ).toBe(true);
  });

  it("does not allow subdomains by accident", () => {
    const config = { ...baseConfig, allowedOrigins: ["https://example.com"] };
    expect(
      isOriginAllowed(
        { origin: "https://evil.example.com", basePath: "/.well-known/agent-skills" },
        config
      )
    ).toBe(false);
  });

  it("treats different ports as distinct", () => {
    const config = { ...baseConfig, allowedOrigins: ["https://example.com"] };
    expect(
      isOriginAllowed(
        { origin: "https://example.com:8443", basePath: "/.well-known/agent-skills" },
        config
      )
    ).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  const allowed = { allowedOrigins: ["https://example.com"], allowHttp: false };

  it("accepts an https url whose origin is allowlisted", () => {
    expect(() =>
      assertUrlAllowed("https://example.com/skills/a/SKILL.md", allowed)
    ).not.toThrow();
  });

  it("rejects an off-allowlist origin (SSRF / cross-origin artifact)", () => {
    expect(() =>
      assertUrlAllowed("https://169.254.169.254/latest/meta-data", allowed)
    ).toThrow(/not in WELL_KNOWN_ALLOWED_ORIGINS/);
    expect(() =>
      assertUrlAllowed("https://cdn.example.com/a.tgz", allowed)
    ).toThrow(/not in WELL_KNOWN_ALLOWED_ORIGINS/);
  });

  it("rejects http when allowHttp is false, even if origin matches", () => {
    expect(() =>
      assertUrlAllowed("http://example.com/a", allowed)
    ).toThrow(/disallowed scheme/);
  });

  it("permits http only when allowHttp is set and origin matches", () => {
    const cfg = { allowedOrigins: ["http://example.com"], allowHttp: true };
    expect(() => assertUrlAllowed("http://example.com/a", cfg)).not.toThrow();
    // still origin-gated
    expect(() => assertUrlAllowed("http://evil.com/a", cfg)).toThrow(
      /not in WELL_KNOWN_ALLOWED_ORIGINS/
    );
  });

  it("rejects non-http(s) schemes (file:, etc.)", () => {
    expect(() => assertUrlAllowed("file:///etc/passwd", allowed)).toThrow(
      /disallowed scheme/
    );
  });
});

describe("getWellKnownCacheKey", () => {
  it("produces a unique key per host + base path", () => {
    const a = getWellKnownCacheKey({
      origin: "https://example.com",
      basePath: "/.well-known/agent-skills",
    });
    const b = getWellKnownCacheKey({
      origin: "https://example.com",
      basePath: "/team/.well-known/agent-skills",
    });
    expect(a).not.toBe(b);
  });

  it("collapses unsafe characters", () => {
    const key = getWellKnownCacheKey({
      origin: "https://example.com:8443",
      basePath: "/.well-known/agent-skills",
    });
    expect(key).not.toMatch(/[^a-z0-9._-]/);
  });
});

describe("getWellKnownCachePath", () => {
  it("places the cache under the given cacheDir", () => {
    const cachePath = getWellKnownCachePath(
      { origin: "https://example.com", basePath: "/.well-known/agent-skills" },
      "/cache"
    );
    expect(cachePath.startsWith(path.join("/cache"))).toBe(true);
  });
});

describe("URL helpers", () => {
  const spec = {
    origin: "https://example.com",
    basePath: "/.well-known/agent-skills",
  };

  it("getWellKnownIndexUrl points at index.json", () => {
    expect(getWellKnownIndexUrl(spec)).toBe(
      "https://example.com/.well-known/agent-skills/index.json"
    );
  });

  it("resolveArtifactUrl resolves path-absolute URLs", () => {
    expect(resolveArtifactUrl(spec, "/.well-known/agent-skills/foo/SKILL.md")).toBe(
      "https://example.com/.well-known/agent-skills/foo/SKILL.md"
    );
  });

  it("resolveArtifactUrl resolves relative URLs against the index URL", () => {
    expect(resolveArtifactUrl(spec, "foo/SKILL.md")).toBe(
      "https://example.com/.well-known/agent-skills/foo/SKILL.md"
    );
  });

  it("resolveArtifactUrl preserves absolute URLs", () => {
    expect(
      resolveArtifactUrl(spec, "https://cdn.example.com/v2/foo.tar.gz")
    ).toBe("https://cdn.example.com/v2/foo.tar.gz");
  });
});
