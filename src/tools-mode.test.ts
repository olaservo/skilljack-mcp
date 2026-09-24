import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import type { ClientCapabilities } from "@modelcontextprotocol/client";
import { SKILLS_EXTENSION_ID } from "@olaservo/ext-skills/server";
import {
  registerSkillTool,
  installToolsMode,
  getCatalogInstructions,
  ToolsMode,
} from "./skill-tool.js";
import { generateInstructions, BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";
import {
  createTestSkill,
  createTestSkillState,
  createTestSource,
} from "./__test-helpers__/helpers.js";

const SKILLS_CLIENT: ClientCapabilities = { extensions: { [SKILLS_EXTENSION_ID]: {} } };
const PLAIN_CLIENT: ClientCapabilities = { roots: {} };

async function toolNames(mode: ToolsMode, capabilities: ClientCapabilities): Promise<string[]> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const state = createTestSkillState([createTestSkill({ name: "a", baseName: "a" })]);
  installToolsMode(server, registerSkillTool(server, state), mode);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities });
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
}

const SKILL_TOOLS = ["load-skill", "skill-resource"];

describe("--tools mode", () => {
  it("auto: disables the skill tools for a client that declares the skills extension", async () => {
    const names = await toolNames("auto", SKILLS_CLIENT);
    for (const t of SKILL_TOOLS) expect(names).not.toContain(t);
  });

  it("auto: offers the skill tools to a client without the extension", async () => {
    const names = await toolNames("auto", PLAIN_CLIENT);
    for (const t of SKILL_TOOLS) expect(names).toContain(t);
  });

  it("always: offers the skill tools even to a skills-aware client", async () => {
    const names = await toolNames("always", SKILLS_CLIENT);
    for (const t of SKILL_TOOLS) expect(names).toContain(t);
  });

  it("never: offers the skill tools to nobody", async () => {
    const names = await toolNames("never", PLAIN_CLIENT);
    for (const t of SKILL_TOOLS) expect(names).not.toContain(t);
  });
});

describe("host-neutral catalog", () => {
  it("lists each skill's SKILL.md URI", () => {
    const skill = createTestSkill({ name: "test__a", baseName: "a", source: createTestSource() });
    expect(generateInstructions([skill])).toContain("<uri>skill://test/a/SKILL.md</uri>");
  });

  it("tells skills-aware hosts to load by URI and others to call load-skill", () => {
    const text = getCatalogInstructions(
      createTestSkillState([createTestSkill({ name: "a", baseName: "a", source: BUNDLED_SKILL_SOURCE })])
    );
    expect(text).toContain(SKILLS_EXTENSION_ID);
    expect(text).toContain("`load-skill`");
    expect(text).toContain("<uri>skill://a/SKILL.md</uri>");
  });
});
