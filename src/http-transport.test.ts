import { describe, it, expect } from "vitest";
import * as path from "node:path";
import type * as http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "./http-transport.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";
import { BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";

const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

function portOf(server: http.Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("stateless HTTP transport", () => {
  it("serves the core skill surface (tools + resources) over Streamable HTTP", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const state = createTestSkillState([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const server = await startHttpServer(0, state);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${portOf(server)}/mcp`)
    );

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain("load-skill");
      expect(toolNames).toContain("skill-resource");

      const resources = await client.listResources();
      const uris = resources.resources.map((r) => r.uri);
      expect(uris).toContain("skill://test-skill/SKILL.md");
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects non-POST requests", async () => {
    const state = createTestSkillState([]);
    const server = await startHttpServer(0, state);
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(server)}/mcp`, { method: "GET" });
      expect(res.status).toBe(405);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
