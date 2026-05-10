import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as tar from "tar";
import {
  syncWellKnown,
  validateIndexDocument,
  archiveFormatFromUrl,
  IndexEntry,
  SyncOptions,
} from "./well-known-sync.js";
import { WellKnownSpec, getWellKnownIndexPath, getWellKnownSkillPath } from "./well-known-config.js";

/**
 * SHA-256 of a buffer in `sha256:<hex>` form (matches well-known-sync's format).
 */
function digestOf(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a SKILL.md with valid frontmatter and the given name/description.
 */
function makeSkillMd(name: string, description: string, body = "Test skill body."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * Tiny HTTP fixture: serves a route table of `path → response`. Updates to
 * the table take effect immediately (so tests can swap responses mid-sync).
 */
interface RouteResponse {
  status?: number;
  contentType?: string;
  body: Buffer | string;
  delay?: number;
}

interface FixtureServer {
  baseUrl: string;
  routes: Map<string, RouteResponse>;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, RouteResponse>();
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = typeof route.body === "string" ? Buffer.from(route.body) : route.body;
    res.writeHead(route.status ?? 200, {
      "Content-Type": route.contentType ?? "application/octet-stream",
      "Content-Length": String(body.byteLength),
    });
    if (route.delay) {
      setTimeout(() => res.end(body), route.delay);
    } else {
      res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    routes,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

/**
 * Build a small tar.gz buffer containing the given file map.
 * `files` keys are entry paths inside the archive (relative).
 */
async function makeTarGz(files: Record<string, string>): Promise<Buffer> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wktest-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(tmpRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const tgzPath = path.join(tmpRoot, "out.tar.gz");
    await tar.c(
      { gzip: true, cwd: tmpRoot, file: tgzPath },
      Object.keys(files)
    );
    return fs.readFileSync(tgzPath);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Build a malicious tar.gz containing an entry whose name attempts path
 * traversal. We construct the tar manually because the `tar` library
 * normalizes relative paths during creation.
 */
function makeMaliciousTarGz(entryName: string, content: string): Buffer {
  // POSIX ustar header is 512 bytes; pad name field exactly.
  const block = Buffer.alloc(512);
  block.write(entryName, 0, 100, "utf-8");
  // mode: 0644
  block.write("0000644 ", 100, 8, "utf-8");
  // uid/gid
  block.write("0000000 ", 108, 8, "utf-8");
  block.write("0000000 ", 116, 8, "utf-8");
  // size in octal
  const size = Buffer.byteLength(content, "utf-8");
  block.write(size.toString(8).padStart(11, "0") + " ", 124, 12, "utf-8");
  // mtime
  block.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + " ", 136, 12, "utf-8");
  // checksum placeholder (8 spaces during sum)
  block.write("        ", 148, 8, "utf-8");
  // typeflag '0' = regular file
  block.write("0", 156, 1, "utf-8");
  // ustar magic
  block.write("ustar\x0000", 257, 8, "utf-8");
  // Compute checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i];
  const chk = sum.toString(8).padStart(6, "0") + "\x00 ";
  block.write(chk, 148, 8, "binary");

  const data = Buffer.from(content, "utf-8");
  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512);
  // Two trailing zero blocks signal end of archive
  const trailer = Buffer.alloc(1024);

  const tarBytes = Buffer.concat([block, data, padding, trailer]);
  return zlib.gzipSync(tarBytes);
}

describe("validateIndexDocument", () => {
  it("accepts a minimal valid v0.2.0 index", () => {
    const doc = {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "demo",
          type: "skill-md",
          description: "Demo skill",
          url: "/.well-known/agent-skills/demo/SKILL.md",
          digest: "sha256:" + "a".repeat(64),
        },
      ],
    };
    const out = validateIndexDocument(doc);
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].name).toBe("demo");
  });

  it("rejects non-object input", () => {
    expect(() => validateIndexDocument(42 as unknown)).toThrow();
  });

  it("rejects when skills is not an array", () => {
    expect(() => validateIndexDocument({ skills: "nope" })).toThrow(/skills.*array/);
  });

  it("skips entries with malformed digest", () => {
    const out = validateIndexDocument({
      skills: [
        {
          name: "demo",
          type: "skill-md",
          description: "x",
          url: "/x",
          digest: "sha512:" + "a".repeat(128),
        },
      ],
    });
    expect(out.skills).toHaveLength(0);
  });

  it("skips entries with invalid skill names", () => {
    const out = validateIndexDocument({
      skills: [
        {
          name: "Bad-Name",
          type: "skill-md",
          description: "x",
          url: "/x",
          digest: "sha256:" + "0".repeat(64),
        },
      ],
    });
    expect(out.skills).toHaveLength(0);
  });
});

describe("archiveFormatFromUrl", () => {
  it("detects tar.gz", () => {
    expect(archiveFormatFromUrl("https://x.com/foo.tar.gz")).toBe("tar.gz");
    expect(archiveFormatFromUrl("https://x.com/foo.tgz")).toBe("tar.gz");
  });
  it("detects zip", () => {
    expect(archiveFormatFromUrl("https://x.com/foo.zip")).toBe("zip");
  });
  it("ignores query and fragment", () => {
    expect(archiveFormatFromUrl("https://x.com/foo.tar.gz?v=1#h")).toBe("tar.gz");
  });
  it("returns null for unrecognized", () => {
    expect(archiveFormatFromUrl("https://x.com/foo")).toBe(null);
    expect(archiveFormatFromUrl("https://x.com/SKILL.md")).toBe(null);
  });
});

describe("syncWellKnown", () => {
  let server: FixtureServer;
  let cacheDir: string;
  let spec: WellKnownSpec;
  let options: SyncOptions;

  beforeEach(async () => {
    server = await startFixtureServer();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wkcache-"));
    spec = {
      origin: server.baseUrl,
      basePath: "/.well-known/agent-skills",
    };
    options = {
      cacheDir,
      maxArtifactBytes: 1024 * 1024,
      maxUnpackedBytes: 1024 * 1024,
    };
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function setSkillMd(name: string, body: string): { url: string; digest: string } {
    const url = `/.well-known/agent-skills/${name}/SKILL.md`;
    server.routes.set(url, {
      contentType: "text/markdown",
      body,
    });
    return { url, digest: digestOf(body) };
  }

  function setIndex(entries: IndexEntry[]): void {
    const doc = {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: entries,
    };
    server.routes.set("/.well-known/agent-skills/index.json", {
      contentType: "application/json",
      body: JSON.stringify(doc),
    });
  }

  it("syncs a single skill-md entry, verifying digest", async () => {
    const body = makeSkillMd("demo", "A demo skill.");
    const { url, digest } = setSkillMd("demo", body);
    setIndex([
      { name: "demo", type: "skill-md", description: "demo", url, digest },
    ]);

    const result = await syncWellKnown(spec, options);

    expect(result.error).toBeUndefined();
    expect(result.skillsSynced).toEqual(["demo"]);
    expect(result.updated).toBe(true);

    const skillPath = path.join(getWellKnownSkillPath(spec, "demo", cacheDir), "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(body);

    // Cached index.json is written after a successful sync.
    expect(fs.existsSync(getWellKnownIndexPath(spec, cacheDir))).toBe(true);
  });

  it("rejects an entry whose digest does not match the artifact", async () => {
    const body = makeSkillMd("demo", "valid body");
    const { url } = setSkillMd("demo", body);
    setIndex([
      {
        name: "demo",
        type: "skill-md",
        description: "demo",
        url,
        digest: "sha256:" + "0".repeat(64),
      },
    ]);

    const result = await syncWellKnown(spec, options);

    expect(result.error).toBeUndefined(); // top-level fetch succeeded
    expect(result.skillsSynced).toEqual([]);
    expect(result.skillErrors.demo).toMatch(/Digest mismatch/);
    const skillPath = path.join(getWellKnownSkillPath(spec, "demo", cacheDir), "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it("rejects oversized artifacts (size cap)", async () => {
    const big = "x".repeat(5000);
    const body = makeSkillMd("big", "huge", big);
    const { url, digest } = setSkillMd("big", body);
    setIndex([
      { name: "big", type: "skill-md", description: "big", url, digest },
    ]);

    // Cap is large enough for the small index but small enough to reject the
    // 5KB skill body.
    const tinyOptions = { ...options, maxArtifactBytes: 1000 };
    const result = await syncWellKnown(spec, tinyOptions);

    expect(result.error).toBeUndefined();
    expect(result.skillErrors.big).toMatch(/exceeds size cap/);
    expect(result.skillsSynced).toEqual([]);
  });

  it("warns and skips entries with unknown type, but other entries still load", async () => {
    const body = makeSkillMd("good", "ok");
    const { url, digest } = setSkillMd("good", body);
    setIndex([
      {
        name: "exotic",
        type: "future-format",
        description: "x",
        url: "/x",
        digest: "sha256:" + "0".repeat(64),
      },
      { name: "good", type: "skill-md", description: "good", url, digest },
    ]);

    const result = await syncWellKnown(spec, options);
    expect(result.skillsSynced).toEqual(["good"]);
    const goodPath = path.join(getWellKnownSkillPath(spec, "good", cacheDir), "SKILL.md");
    expect(fs.existsSync(goodPath)).toBe(true);
  });

  it("syncs a tar.gz archive entry safely", async () => {
    const skillBody = makeSkillMd("wrangler", "Cloudflare worker tool");
    const buf = await makeTarGz({
      "SKILL.md": skillBody,
      "scripts/deploy.sh": "#!/bin/sh\necho hi\n",
    });
    server.routes.set("/.well-known/agent-skills/wrangler.tar.gz", {
      contentType: "application/gzip",
      body: buf,
    });
    setIndex([
      {
        name: "wrangler",
        type: "archive",
        description: "Cloudflare worker tool",
        url: "/.well-known/agent-skills/wrangler.tar.gz",
        digest: digestOf(buf),
      },
    ]);

    const result = await syncWellKnown(spec, options);
    expect(result.error).toBeUndefined();
    expect(result.skillErrors).toEqual({});
    expect(result.skillsSynced).toEqual(["wrangler"]);

    const skillDir = getWellKnownSkillPath(spec, "wrangler", cacheDir);
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "scripts", "deploy.sh"))).toBe(true);
  });

  it("rejects a tar.gz archive missing SKILL.md at the root", async () => {
    const buf = await makeTarGz({ "other.md": "no skill md here" });
    server.routes.set("/.well-known/agent-skills/empty.tar.gz", {
      contentType: "application/gzip",
      body: buf,
    });
    setIndex([
      {
        name: "empty",
        type: "archive",
        description: "x",
        url: "/.well-known/agent-skills/empty.tar.gz",
        digest: digestOf(buf),
      },
    ]);
    const result = await syncWellKnown(spec, options);
    expect(result.skillErrors.empty).toMatch(/did not contain SKILL\.md/);
    expect(fs.existsSync(getWellKnownSkillPath(spec, "empty", cacheDir))).toBe(false);
  });

  it("rejects a tar.gz archive containing a path-traversal entry", async () => {
    const evilTar = makeMaliciousTarGz("../escape.txt", "pwn");
    server.routes.set("/.well-known/agent-skills/evil.tar.gz", {
      contentType: "application/gzip",
      body: evilTar,
    });
    setIndex([
      {
        name: "evil",
        type: "archive",
        description: "x",
        url: "/.well-known/agent-skills/evil.tar.gz",
        digest: digestOf(evilTar),
      },
    ]);

    const result = await syncWellKnown(spec, options);
    // Either the tar filter silently drops the entry (no SKILL.md follows, so
    // the SKILL.md check trips), or extraction throws outright. Either way,
    // the skill should not be marked as synced and no escape file should
    // exist outside the skill dir.
    expect(result.skillsSynced).toEqual([]);
    const escaped = path.join(path.dirname(getWellKnownSkillPath(spec, "evil", cacheDir)), "escape.txt");
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it("prunes per-skill cache directories when a skill is removed from the index", async () => {
    const aBody = makeSkillMd("alpha", "A");
    const bBody = makeSkillMd("beta", "B");
    const a = setSkillMd("alpha", aBody);
    const b = setSkillMd("beta", bBody);
    setIndex([
      { name: "alpha", type: "skill-md", description: "A", url: a.url, digest: a.digest },
      { name: "beta", type: "skill-md", description: "B", url: b.url, digest: b.digest },
    ]);

    let result = await syncWellKnown(spec, options);
    expect(result.skillsSynced.sort()).toEqual(["alpha", "beta"]);

    // Remove beta from the index and re-sync.
    setIndex([
      { name: "alpha", type: "skill-md", description: "A", url: a.url, digest: a.digest },
    ]);
    result = await syncWellKnown(spec, options);
    expect(result.skillsRemoved).toEqual(["beta"]);
    expect(fs.existsSync(getWellKnownSkillPath(spec, "alpha", cacheDir))).toBe(true);
    expect(fs.existsSync(getWellKnownSkillPath(spec, "beta", cacheDir))).toBe(false);
  });

  it("re-uses the cache when digests are unchanged on a re-sync", async () => {
    const body = makeSkillMd("demo", "x");
    const { url, digest } = setSkillMd("demo", body);
    setIndex([
      { name: "demo", type: "skill-md", description: "x", url, digest },
    ]);
    const first = await syncWellKnown(spec, options);
    expect(first.skillsSynced).toEqual(["demo"]);

    // Replace the on-disk artifact with junk, then resync. Because the digest
    // hasn't changed AND the SKILL.md still exists, we should skip downloads.
    // The artifact body on the file system stays whatever the cache had —
    // but here the file is still good from the first sync. We just check the
    // second sync reports no work.
    const second = await syncWellKnown(spec, options);
    expect(second.skillsSynced).toEqual([]);
    expect(second.updated).toBe(false);
  });

  it("returns a top-level error when the index cannot be fetched", async () => {
    // No index.json route configured → 404
    const result = await syncWellKnown(spec, options);
    expect(result.error).toMatch(/Failed to fetch index/);
    expect(result.skillsSynced).toEqual([]);
  });
});
