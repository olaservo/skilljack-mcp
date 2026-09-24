import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import type { ClientCapabilities } from "@modelcontextprotocol/client";
import { SKILLS_EXTENSION_ID } from "@olaservo/ext-skills/server";
import {
  registerSkillTool,
  installToolsMode,
  getCatalogInstructions,
  CatalogMode,
  ToolsMode,
} from "./skill-tool.js";
import { getToolsMode } from "./index.js";
import { generateInstructions, BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";
import {
  createTestSkill,
  createTestSkillState,
  createTestSource,
} from "./__test-helpers__/helpers.js";

const SKILLS_CLIENT: ClientCapabilities = { extensions: { [SKILLS_EXTENSION_ID]: {} } };
const PLAIN_CLIENT: ClientCapabilities = { roots: {} };
const SKILL_TOOLS = ["load-skill", "skill-resource"];

async function connect(
  mode: ToolsMode,
  capabilities: ClientCapabilities,
  catalogMode: CatalogMode = "instructions"
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const state = createTestSkillState([
    createTestSkill({ name: "a", baseName: "a", source: BUNDLED_SKILL_SOURCE }),
  ]);
  installToolsMode(server, registerSkillTool(server, state, catalogMode), mode, catalogMode);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities });
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  return { names, client, server };
}

async function expectToolsOffered(
  mode: ToolsMode,
  capabilities: ClientCapabilities,
  offered: boolean,
  catalogMode: CatalogMode = "instructions"
) {
  const { names, client, server } = await connect(mode, capabilities, catalogMode);
  try {
    for (const t of SKILL_TOOLS) {
      if (offered) expect(names).toContain(t);
      else expect(names).not.toContain(t);
    }
    const call = client.callTool({ name: "load-skill", arguments: { name: "a" } });
    if (offered) await expect(call).resolves.toBeDefined();
    else await expect(call).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("--tools mode", () => {
  it("auto: disables the skill tools for a client that declares the skills extension", () =>
    expectToolsOffered("auto", SKILLS_CLIENT, false));

  it("auto: offers the skill tools to a client without the extension", () =>
    expectToolsOffered("auto", PLAIN_CLIENT, true));

  it("auto: keeps the tools when the catalog lives in the tool description", () =>
    expectToolsOffered("auto", SKILLS_CLIENT, true, "tool-description"));

  it("always: offers the skill tools even to a skills-aware client", () =>
    expectToolsOffered("always", SKILLS_CLIENT, true));

  it("never: offers the skill tools to nobody", () =>
    expectToolsOffered("never", PLAIN_CLIENT, false));
});

describe("getToolsMode", () => {
  const argv = process.argv;
  const env = process.env.SKILLJACK_TOOLS;
  afterEach(() => {
    process.argv = argv;
    if (env === undefined) delete process.env.SKILLJACK_TOOLS;
    else process.env.SKILLJACK_TOOLS = env;
  });

  it("defaults to auto", () => {
    process.argv = ["node", "index.js"];
    delete process.env.SKILLJACK_TOOLS;
    expect(getToolsMode()).toBe("auto");
  });

  it("reads --tools= before the env var and ignores case", () => {
    process.env.SKILLJACK_TOOLS = "never";
    process.argv = ["node", "index.js", "--tools=Always", "/skills"];
    expect(getToolsMode()).toBe("always");
    process.argv = ["node", "index.js", "/skills"];
    expect(getToolsMode()).toBe("never");
  });

  it("falls back to auto on an unknown value", () => {
    process.argv = ["node", "index.js", "--tools=sometimes"];
    expect(getToolsMode()).toBe("auto");
  });
});

describe("host-neutral catalog", () => {
  const state = () =>
    createTestSkillState([createTestSkill({ name: "a", baseName: "a", source: BUNDLED_SKILL_SOURCE })]);

  it("lists each skill's SKILL.md URI", () => {
    const skill = createTestSkill({ name: "test__a", baseName: "a", source: createTestSource() });
    expect(generateInstructions([skill])).toContain("<uri>skill://test/a/SKILL.md</uri>");
  });

  it("auto: tells skills-aware hosts to load by URI and others to call load-skill", () => {
    const text = getCatalogInstructions(state(), "auto");
    expect(text).toContain(SKILLS_EXTENSION_ID);
    expect(text).toContain("does not offer the `load-skill` tool");
    expect(text).toContain("Otherwise call `load-skill`");
    expect(text).toContain("<uri>skill://a/SKILL.md</uri>");
  });

  it("always: documents both paths without claiming the tool is withheld", () => {
    const text = getCatalogInstructions(state(), "always");
    expect(text).toContain("Otherwise call `load-skill`");
    expect(text).not.toContain("does not offer");
  });

  it("never: names no tool to call", () => {
    const text = getCatalogInstructions(state(), "never");
    expect(text).toContain("no skill-loading tool");
    expect(text).not.toContain("call `load-skill`");
    expect(text).toContain("resources/read");
  });
});
