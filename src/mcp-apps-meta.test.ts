import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { registerSkillDisplayTool } from "./skill-display-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";

/**
 * Hosts locate a tool's UI by reading `_meta['ui/resourceUri']` and/or
 * `_meta.ui.resourceUri`. If either stops being advertised the app stops
 * rendering with no error, and no other test in this repo would notice.
 */

let configHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-apps-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = configHome;
  process.env.USERPROFILE = configHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(configHome, { recursive: true, force: true });
});

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const state = createTestSkillState([]);
  registerSkillConfigTool(server, state, () => {});
  registerSkillDisplayTool(server, state, () => {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP Apps metadata on the wire", () => {
  it("every UI tool advertises its resource under both _meta keys", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const uiTools = tools.filter((t) => t.name.startsWith("skill-config") || t.name.startsWith("skill-display"));
    expect(uiTools.length).toBeGreaterThan(0);

    for (const tool of uiTools) {
      const meta = tool._meta as { ui?: { resourceUri?: string }; "ui/resourceUri"?: string } | undefined;
      const nested = meta?.ui?.resourceUri;
      const flat = meta?.["ui/resourceUri"];
      expect(nested, `${tool.name} _meta.ui.resourceUri`).toMatch(/^ui:\/\//);
      expect(flat, `${tool.name} _meta['ui/resourceUri']`).toBe(nested);
    }
  });

  it("serves both UI resources with the MCP Apps mime type", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uiResources = resources.filter((r) => r.uri.startsWith("ui://"));
    expect(uiResources.map((r) => r.uri).sort()).toEqual(
      ["ui://skill-config/mcp-app.html", "ui://skill-display/skill-display.html"].sort()
    );
    for (const resource of uiResources) {
      expect(resource.mimeType, resource.uri).toBe(RESOURCE_MIME_TYPE);
    }
  });
});
