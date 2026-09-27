import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerSkillTool } from "./skill-tool.js";
import { createTestSkill, createTestSkillState, createTestSource } from "./__test-helpers__/helpers.js";

/**
 * The skill-resource tool used to decode every file as UTF-8, so a PNG or a
 * Latin-1 CSV came back with its bytes replaced. It now serves files the way
 * resources/read does (#114): text only for valid UTF-8 under a text MIME
 * type, otherwise an embedded base64 resource.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-tool-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00]);
const LATIN1_CSV = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

function makeSkill() {
  const skillDir = path.join(root, "bin");
  fs.mkdirSync(path.join(skillDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: bin\ndescription: d\n---\nbody\n");
  fs.writeFileSync(path.join(skillDir, "assets", "logo.png"), PNG);
  fs.writeFileSync(path.join(skillDir, "assets", "data.csv"), LATIN1_CSV);
  fs.writeFileSync(path.join(skillDir, "assets", "notes.txt"), "plain text\n");
  fs.writeFileSync(path.join(skillDir, "assets", "latin1.txt"), LATIN1_CSV);
  fs.mkdirSync(path.join(skillDir, ".secrets"));
  fs.writeFileSync(path.join(skillDir, ".secrets", "key.p12"), PNG);
  fs.writeFileSync(path.join(skillDir, ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(skillDir, "Makefile"), "all:\n\techo ok\n");
  return createTestSkill({
    name: "bin",
    baseName: "bin",
    path: path.join(skillDir, "SKILL.md"),
    source: createTestSource({ prefix: "" }),
  });
}

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerSkillTool(server, createTestSkillState([makeSkill()]));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

type Content =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; blob?: string; text?: string } };

async function read(client: Client, filePath: string): Promise<Content[]> {
  const result = await client.callTool({ name: "skill-resource", arguments: { skill: "bin", path: filePath } });
  expect(result.isError, filePath).toBeFalsy();
  return result.content as Content[];
}

describe("skill-resource tool file contents", () => {
  it("returns a binary file as an embedded resource with its bytes intact", async () => {
    const client = await connect();
    for (const [file, mimeType, bytes] of [
      ["assets/logo.png", "image/png", PNG],
      ["assets/data.csv", "application/octet-stream", LATIN1_CSV],
    ] as const) {
      const [content] = await read(client, file);
      expect(content.type, file).toBe("resource");
      if (content.type !== "resource") throw new Error("unreachable");
      expect(content.resource.uri, file).toBe(`skill://bin/${file}`);
      expect(content.resource.mimeType, file).toBe(mimeType);
      expect(content.resource.text, file).toBeUndefined();
      expect(Buffer.from(content.resource.blob!, "base64").equals(bytes), file).toBe(true);
    }
  });

  it("still returns text files as text, including extensionless ones", async () => {
    const client = await connect();
    expect(await read(client, "assets/notes.txt")).toEqual([{ type: "text", text: "plain text\n" }]);
    expect(await read(client, "Makefile")).toEqual([{ type: "text", text: "all:\n\techo ok\n" }]);
  });

  it("refuses files resources/read would refuse: hidden files and SKILL.md", async () => {
    const client = await connect();
    for (const file of [".env", ".secrets/key.p12", "SKILL.md"]) {
      const result = await client.callTool({ name: "skill-resource", arguments: { skill: "bin", path: file } });
      expect(result.isError, file).toBe(true);
      const [content] = result.content as Content[];
      expect(content.type, file).toBe("text");
      if (content.type === "text") expect(content.text, file).not.toContain("TOKEN");
    }
  });

  it("describes binary files in a directory read instead of dumping their bytes", async () => {
    const client = await connect();
    const contents = await read(client, "assets");
    const texts = contents.map((c) => (c.type === "text" ? c.text : "")).sort();
    expect(texts).toEqual(
      [
        "--- assets/notes.txt ---\nplain text\n",
        `--- assets/logo.png ---\n[Binary file (image/png, ${PNG.length} bytes). Read it on its own to get the bytes.]`,
        `--- assets/data.csv ---\n[Binary file (application/octet-stream, ${LATIN1_CSV.length} bytes). Read it on its own to get the bytes.]`,
        `--- assets/latin1.txt ---\n[Not valid UTF-8 (text/plain, ${LATIN1_CSV.length} bytes). Read it on its own to get the bytes.]`,
      ].sort()
    );
  });
});
