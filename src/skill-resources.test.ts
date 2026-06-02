import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSkillResources } from "./skill-resources.js";
import { resolveUriToFilePaths } from "./subscriptions.js";
import { BUNDLED_SKILL_SOURCE } from "./skill-discovery.js";
import {
  createTestSkill,
  createTestSkillState,
  createTestSource,
} from "./__test-helpers__/helpers.js";

const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

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

describe("SKILL.md resource (SEP-2640)", () => {
  it("lists one SKILL.md resource per skill at the SEP URI shape", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const expectedSize = fs.statSync(skillPath).size;

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const skillResource = result.resources.find(
      (r) => r.uri === "skill://test-skill/SKILL.md"
    );

    expect(skillResource).toBeDefined();
    expect(skillResource!.mimeType).toBe("text/markdown");
    expect(skillResource!.name).toBe("test-skill");
    expect(skillResource!.size).toBe(expectedSize);
  });

  it("uses prefix as URI path segment for non-bundled skills", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "my-project__test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: createTestSource({ prefix: "my-project" }),
      }),
    ]);

    const result = await client.listResources();
    const skillResource = result.resources.find(
      (r) => r.uri === "skill://my-project/test-skill/SKILL.md"
    );

    expect(skillResource).toBeDefined();
  });

  it("returns SKILL.md content via resources/read", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const expectedContent = fs.readFileSync(skillPath, "utf-8");

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.readResource({
      uri: "skill://test-skill/SKILL.md",
    });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("text/markdown");
    expect(result.contents[0].text).toBe(expectedContent);
  });

  it("includes audience annotations and priority 0.8", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
        effectiveAssistantInvocable: true,
        effectiveUserInvocable: false,
      }),
    ]);

    const result = await client.listResources();
    const resource = result.resources.find(
      (r) => r.uri === "skill://test-skill/SKILL.md"
    );

    expect(resource).toBeDefined();
    expect(resource!.annotations?.priority).toBe(0.8);
    expect(resource!.annotations?.audience).toEqual(["assistant"]);
  });

  it("omits size when SKILL.md path does not exist", async () => {
    const client = await createConnectedClient([
      createTestSkill({
        name: "missing",
        baseName: "missing",
        path: "/fake/path/SKILL.md",
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const resource = result.resources.find(
      (r) => r.uri === "skill://missing/SKILL.md"
    );

    expect(resource).toBeDefined();
    expect(resource!.size).toBeUndefined();
  });

  it("does not list bare skill:// or trailing-slash URIs (legacy shapes)", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const legacyBare = result.resources.find((r) => r.uri === "skill://test-skill");
    const legacyDir = result.resources.find((r) => r.uri === "skill://test-skill/");
    expect(legacyBare).toBeUndefined();
    expect(legacyDir).toBeUndefined();
  });
});

describe("supporting-file resource (SEP-2640)", () => {
  it("lists every supporting file in resources/list", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    // Includes a nested-subdir file, exercising listSkillFiles recursion.
    expect(uris).toContain("skill://resourceful/scripts/example.py");
    expect(uris).toContain("skill://resourceful/templates/config.json");
  });

  it("gives supporting files priority 0.3 (below SKILL.md 0.8, index 0.5)", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
        effectiveAssistantInvocable: true,
        effectiveUserInvocable: false,
      }),
    ]);

    const result = await client.listResources();
    const md = result.resources.find((r) => r.uri === "skill://resourceful/SKILL.md");
    const script = result.resources.find(
      (r) => r.uri === "skill://resourceful/scripts/example.py"
    );
    const index = result.resources.find((r) => r.uri === "skill://index.json");

    expect(md!.annotations?.priority).toBe(0.8);
    expect(index!.annotations?.priority).toBe(0.5);
    expect(script!.annotations?.priority).toBe(0.3);
    // audience inherited from the owning skill
    expect(script!.annotations?.audience).toEqual(["assistant"]);
  });

  it("sets correct mimeType and best-effort size on listed files", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");
    const scriptAbs = path.join(
      FIXTURES_DIR,
      "with-resources",
      "scripts",
      "example.py"
    );
    const expectedSize = fs.statSync(scriptAbs).size;

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const script = result.resources.find(
      (r) => r.uri === "skill://resourceful/scripts/example.py"
    );
    const config = result.resources.find(
      (r) => r.uri === "skill://resourceful/templates/config.json"
    );

    expect(script!.mimeType).toBe("text/x-python");
    expect(script!.size).toBe(expectedSize);
    expect(config!.mimeType).toBe("application/json");
  });

  it("returns file content on resources/read at skill://<path>/<file>", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");
    const expectedScript = fs.readFileSync(
      path.join(FIXTURES_DIR, "with-resources", "scripts", "example.py"),
      "utf-8"
    );

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.readResource({
      uri: "skill://resourceful/scripts/example.py",
    });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toBe(expectedScript);
    expect(result.contents[0].mimeType).toBe("text/x-python");
  });

  it("rejects path traversal attempts", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    await expect(
      client.readResource({
        uri: "skill://resourceful/..%2F..%2Fetc%2Fpasswd",
      })
    ).rejects.toThrow();
  });

  it("errors cleanly when file does not exist", async () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    await expect(
      client.readResource({ uri: "skill://resourceful/nope.txt" })
    ).rejects.toThrow();
  });

  it("resolves a listed file URI to its concrete file path (subscribable)", () => {
    const skillPath = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");
    const scriptAbs = path.join(
      FIXTURES_DIR,
      "with-resources",
      "scripts",
      "example.py"
    );
    const state = createTestSkillState([
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const paths = resolveUriToFilePaths(
      "skill://resourceful/scripts/example.py",
      state
    );
    expect(paths).toContain(path.resolve(scriptAbs));
  });
});

describe("skill://index.json (SEP-2640 discovery)", () => {
  it("is listed exactly once in resources/list", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.listResources();
    const indexes = result.resources.filter((r) => r.uri === "skill://index.json");
    expect(indexes).toHaveLength(1);
    expect(indexes[0].mimeType).toBe("application/json");
  });

  it("returns SEP-shaped JSON on resources/read", async () => {
    const skillPath1 = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");
    const skillPath2 = path.join(FIXTURES_DIR, "with-resources", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "test-skill",
        baseName: "test-skill",
        description: "valid test skill",
        path: skillPath1,
        source: BUNDLED_SKILL_SOURCE,
      }),
      createTestSkill({
        name: "resourceful",
        baseName: "resourceful",
        description: "skill with files",
        path: skillPath2,
        source: BUNDLED_SKILL_SOURCE,
      }),
    ]);

    const result = await client.readResource({ uri: "skill://index.json" });
    expect(result.contents).toHaveLength(1);
    const body = JSON.parse(result.contents[0].text as string);

    expect(body.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
    );
    expect(body.skills).toHaveLength(2);

    const test = body.skills.find((s: { name: string }) => s.name === "test-skill");
    expect(test).toMatchObject({
      name: "test-skill",
      type: "skill-md",
      description: "valid test skill",
      url: "skill://test-skill/SKILL.md",
    });

    const resourceful = body.skills.find(
      (s: { name: string }) => s.name === "resourceful"
    );
    expect(resourceful).toMatchObject({
      name: "resourceful",
      type: "skill-md",
      description: "skill with files",
      url: "skill://resourceful/SKILL.md",
    });
  });

  it("uses prefixed URLs for non-bundled skills", async () => {
    const skillPath = path.join(FIXTURES_DIR, "valid-skill", "SKILL.md");

    const client = await createConnectedClient([
      createTestSkill({
        name: "my-project__test-skill",
        baseName: "test-skill",
        path: skillPath,
        source: createTestSource({ prefix: "my-project" }),
      }),
    ]);

    const result = await client.readResource({ uri: "skill://index.json" });
    const body = JSON.parse(result.contents[0].text as string);
    expect(body.skills[0].url).toBe("skill://my-project/test-skill/SKILL.md");
  });
});
