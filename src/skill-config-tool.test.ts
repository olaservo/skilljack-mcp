import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { createTestSkillState } from "./__test-helpers__/helpers.js";

/**
 * These tests go through a real Client on purpose. The SDK only validates a tool's
 * structuredContent against its advertised outputSchema after tools/list has been
 * called, so a mismatch is invisible to a test that calls the handler directly.
 * That is how #94 shipped: six tools returned more keys than they declared, and
 * every client that had called tools/list got -32602 instead of a result.
 */

let configHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-cfg-"));
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
  registerSkillConfigTool(server, createTestSkillState([]), () => {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

describe("skill-config tool output schemas", () => {
  it("every config tool's success result validates against its advertised outputSchema", async () => {
    const client = await connect();
    // Arms the SDK's output-schema validators. Without this the calls below pass
    // regardless of whether the schemas are right.
    const { tools } = await client.listTools();

    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-dir-"));
    const calls: Array<[string, Record<string, unknown>]> = [
      ["skill-config", {}],
      ["skill-config-add-directory", { directory: skillsDir }],
      ["skill-config-remove-directory", { directory: skillsDir }],
      ["skill-config-add-allowed-org", { org: "example-org" }],
      ["skill-config-remove-allowed-org", { org: "example-org" }],
      ["skill-config-add-allowed-origin", { origin: "https://example.com" }],
      ["skill-config-remove-allowed-origin", { origin: "https://example.com" }],
      ["skill-config-set-static-mode", { enabled: true }],
    ];

    for (const [name, args] of calls) {
      expect(tools.map((t) => t.name)).toContain(name);
      // Rejects with -32602 "data must NOT have additional properties" when the
      // handler returns keys the outputSchema does not declare.
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} returned isError`).toBeFalsy();
    }

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it("declares every key the mutating tools actually return", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const returned = [
      "success",
      "directories",
      "activeSource",
      "isOverridden",
      "staticMode",
      "allowedOrgs",
      "allowedUsers",
      "allowedOrigins",
      "error",
    ];

    for (const name of [
      "skill-config-add-directory",
      "skill-config-remove-directory",
      "skill-config-add-allowed-org",
      "skill-config-remove-allowed-org",
      "skill-config-add-allowed-origin",
      "skill-config-remove-allowed-origin",
    ]) {
      const tool = tools.find((t) => t.name === name);
      const props = Object.keys(
        (tool?.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
      );
      expect(props.sort(), `${name} outputSchema`).toEqual([...returned].sort());
    }
  });
});
