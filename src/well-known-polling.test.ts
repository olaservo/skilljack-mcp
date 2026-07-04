import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createWellKnownPollingManager } from "./well-known-polling.js";
import { syncWellKnown, SyncOptions } from "./well-known-sync.js";
import { WellKnownSpec } from "./well-known-config.js";

function digestOf(s: string): string {
  return "sha256:" + crypto.createHash("sha256").update(s).digest("hex");
}

function skillBody(name: string, version: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\nversion: ${version}\n`;
}

interface FixtureServer {
  baseUrl: string;
  setIndex(body: string): void;
  setRoute(path: string, body: string, contentType?: string): void;
  close(): Promise<void>;
}

async function startServer(): Promise<FixtureServer> {
  const routes = new Map<string, { body: Buffer; contentType: string; etag: string }>();
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const inm = req.headers["if-none-match"];
    if (inm && inm === route.etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": route.contentType,
      "Content-Length": String(route.body.byteLength),
      ETag: route.etag,
    });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setIndex(body: string) {
      this.setRoute("/.well-known/agent-skills/index.json", body, "application/json");
    },
    setRoute(p: string, body: string, contentType = "text/markdown") {
      const buf = Buffer.from(body, "utf-8");
      routes.set(p, {
        body: buf,
        contentType,
        etag: '"' + crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) + '"',
      });
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

describe("createWellKnownPollingManager", () => {
  let server: FixtureServer;
  let cacheDir: string;
  let spec: WellKnownSpec;
  let options: SyncOptions;

  beforeEach(async () => {
    server = await startServer();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wkpoll-"));
    spec = { origin: server.baseUrl, basePath: "/.well-known/agent-skills" };
    options = {
      cacheDir,
      maxArtifactBytes: 1024 * 1024,
      maxUnpackedBytes: 1024 * 1024,
      allowedOrigins: [server.baseUrl],
      allowHttp: true,
    };
  });

  afterEach(async () => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await server.close();
  });

  it("calls onUpdate when the index changes", async () => {
    // Initial state.
    const aBody = skillBody("alpha", "1");
    server.setRoute("/.well-known/agent-skills/alpha/SKILL.md", aBody);
    server.setIndex(
      JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "alpha",
            type: "skill-md",
            description: "a",
            url: "/.well-known/agent-skills/alpha/SKILL.md",
            digest: digestOf(aBody),
          },
        ],
      })
    );

    // Prime the cache.
    const first = await syncWellKnown(spec, options);
    expect(first.skillsSynced).toEqual(["alpha"]);

    let updateCount = 0;
    const updates: string[] = [];
    const manager = createWellKnownPollingManager([spec], options, {
      intervalMs: 0, // We'll trigger checkNow manually
      onUpdate: (s) => {
        updateCount += 1;
        updates.push(s.origin);
      },
    });

    // No change → no update.
    await manager.checkNow();
    expect(updateCount).toBe(0);

    // Change the published artifact (and thus the index digest).
    const aBody2 = skillBody("alpha", "2");
    server.setRoute("/.well-known/agent-skills/alpha/SKILL.md", aBody2);
    server.setIndex(
      JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "alpha",
            type: "skill-md",
            description: "a",
            url: "/.well-known/agent-skills/alpha/SKILL.md",
            digest: digestOf(aBody2),
          },
        ],
      })
    );

    await manager.checkNow();
    expect(updateCount).toBe(1);
    expect(updates).toEqual([server.baseUrl]);
  });

  it("does not start the timer when interval <= 0", () => {
    const manager = createWellKnownPollingManager([spec], options, {
      intervalMs: 0,
      onUpdate: () => {},
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });

  it("does not start the timer when there are no specs", () => {
    const manager = createWellKnownPollingManager([], options, {
      intervalMs: 1000,
      onUpdate: () => {},
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });
});
