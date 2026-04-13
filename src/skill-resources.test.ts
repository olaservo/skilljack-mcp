import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSkillResources } from "./skill-resources.js";
import { createTestSkill, createTestSkillState } from "./__test-helpers__/helpers.js";

const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

/**
 * Helper: wire up a McpServer + Client over InMemoryTransport,
 * register skill resources, and return the connected client.
 */
async function createConnectedClient(
  skills: ReturnType<typeof createTestSkill>[]
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const skillState = createTestSkillState(skills);
  registerSkillResources(server, skillState);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);

  return client;
}

describe("skill resources: size field", () => {
  it("includes size on skill template resources for real files", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const expectedSize = fs.statSync(skillPath).size;

    const client = await createConnectedClient([
      createTestSkill({ name: "valid", path: skillPath }),
    ]);

    const result = await client.listResources();
    const skillResource = result.resources.find(
      (r) => r.uri === "skill://valid"
    );

    expect(skillResource).toBeDefined();
    expect(skillResource!.size).toBe(expectedSize);
  });

  it("includes size on skill directory collection resources for real files", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const expectedSize = fs.statSync(skillPath).size;

    const client = await createConnectedClient([
      createTestSkill({ name: "valid", path: skillPath }),
    ]);

    const result = await client.listResources();
    const dirResource = result.resources.find(
      (r) => r.uri === "skill://valid/"
    );

    expect(dirResource).toBeDefined();
    expect(dirResource!.size).toBe(expectedSize);
  });

  it("omits size when skill path does not exist", async () => {
    const client = await createConnectedClient([
      createTestSkill({ name: "missing", path: "/fake/path/SKILL.md" }),
    ]);

    const result = await client.listResources();
    const skillResource = result.resources.find(
      (r) => r.uri === "skill://missing"
    );

    expect(skillResource).toBeDefined();
    expect(skillResource!.size).toBeUndefined();
  });

  it("includes annotations alongside size", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "annotated",
        path: skillPath,
        effectiveAssistantInvocable: true,
        effectiveUserInvocable: false,
      }),
    ]);

    const result = await client.listResources();
    const resource = result.resources.find(
      (r) => r.uri === "skill://annotated"
    );

    expect(resource).toBeDefined();
    expect(resource!.size).toBeGreaterThan(0);
    expect(resource!.annotations?.audience).toEqual(["assistant"]);
  });
});

describe("skill resources: priority differentiation", () => {
  it("sets priority 0.8 on primary skill resources", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({ name: "test", path: skillPath }),
    ]);

    const result = await client.listResources();
    const resource = result.resources.find(
      (r) => r.uri === "skill://test"
    );

    expect(resource).toBeDefined();
    expect(resource!.annotations?.priority).toBe(0.8);
  });

  it("sets priority 0.3 on directory collection resources", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({ name: "test", path: skillPath }),
    ]);

    const result = await client.listResources();
    const resource = result.resources.find(
      (r) => r.uri === "skill://test/"
    );

    expect(resource).toBeDefined();
    expect(resource!.annotations?.priority).toBe(0.3);
  });
});
