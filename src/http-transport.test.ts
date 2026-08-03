import { describe, it, expect } from "vitest";
import * as path from "node:path";
import type * as http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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

  it("serves refreshed skillState to new connections (discovery-on-change)", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const state = createTestSkillState([
      createTestSkill({
        name: "first-skill",
        baseName: "first-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);
    const server = await startHttpServer(0, state);
    const url = new URL(`http://127.0.0.1:${portOf(server)}/mcp`);

    async function instructionsSeenByNewClient(): Promise<string | undefined> {
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(url);
      try {
        await client.connect(transport);
        return client.getInstructions();
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    }

    try {
      expect(await instructionsSeenByNewClient()).toContain("<name>first-skill</name>");

      // Simulate what refreshSkillState() does on a file change: swap the map.
      const added = createTestSkill({
        name: "second-skill",
        baseName: "second-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      });
      state.skillMap = new Map([
        ...state.skillMap,
        [added.name, added],
      ]);

      const instructions = await instructionsSeenByNewClient();
      expect(instructions).toContain("<name>first-skill</name>");
      expect(instructions).toContain("<name>second-skill</name>");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("catalog modes", () => {
    function makeState() {
      const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
      return createTestSkillState([
        createTestSkill({
          name: "test-skill",
          baseName: "test-skill",
          path: skillPath,
          source: BUNDLED_SKILL_SOURCE,
        }),
      ]);
    }

    async function connectAndInspect(catalogMode?: "tool-description" | "instructions") {
      const server = await startHttpServer(0, makeState(), catalogMode);
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${portOf(server)}/mcp`)
      );
      try {
        await client.connect(transport);
        const instructions = client.getInstructions();
        const tools = await client.listTools();
        const loadSkillDesc = tools.tools.find((t) => t.name === "load-skill")?.description ?? "";
        return { instructions, loadSkillDesc };
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    it("tool-description: no instructions, catalog in tool description", async () => {
      const { instructions, loadSkillDesc } = await connectAndInspect("tool-description");
      expect(instructions).toBeUndefined();
      expect(loadSkillDesc).toContain("<name>test-skill</name>");
    });

    it("instructions (default): catalog + load-skill usage in instructions, usage-only tool description", async () => {
      for (const mode of ["instructions", undefined] as const) {
        const { instructions, loadSkillDesc } = await connectAndInspect(mode);
        expect(instructions).toContain("<name>test-skill</name>");
        expect(instructions).toContain("`load-skill`");
        expect(loadSkillDesc).toContain("Load a skill");
        expect(loadSkillDesc).not.toContain("<available_skills>");
      }
    });
  });
});
