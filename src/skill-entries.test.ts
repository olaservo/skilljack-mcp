import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import {
  SKILLS_LIST_METHOD,
  SKILLS_GET_METHOD,
  SkillsListResultSchema,
  SkillsGetResultSchema,
  sha256Digest,
} from "@olaservo/ext-skills/server";
import { registerSkillResources } from "./skill-resources.js";
import {
  buildSkillEntry,
  clearDigestCache,
  fileDigest,
  pruneDigestCache,
  registerSkillMethods,
} from "./skill-entries.js";
import { BUNDLED_SKILL_SOURCE, discoverSkills } from "./skill-discovery.js";
import { SkillState } from "./skill-tool.js";
import {
  createTestSkill,
  createTestSkillState,
  createTestSource,
} from "./__test-helpers__/helpers.js";

const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__", "skills");

function sha256(file: string): string {
  return sha256Digest(fs.readFileSync(file));
}

function makeTempSkill(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-entries-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return path.join(dir, "SKILL.md");
}

function bundledSkill(name: string, files: Record<string, string> = {}) {
  return createTestSkill({
    name,
    baseName: name,
    path: makeTempSkill({ "SKILL.md": `---\nname: ${name}\ndescription: ${name}\n---\n`, ...files }),
    source: BUNDLED_SKILL_SOURCE,
  });
}

async function connect(skillState: SkillState, register = registerSkillResources) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  register(server, skillState);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function listSkills(client: Client, cursor?: string) {
  return client.request(
    { method: SKILLS_LIST_METHOD, params: cursor ? { cursor } : {} },
    SkillsListResultSchema
  );
}

function getSkill(client: Client, uri: string) {
  return client.request({ method: SKILLS_GET_METHOD, params: { uri } }, SkillsGetResultSchema);
}

/** The with-resources fixture (frontmatter name "resourceful") under a "test" prefix. */
function resourcefulState(): SkillState {
  const skills = discoverSkills(FIXTURES_DIR, createTestSource()).filter(
    (s) => s.baseName === "resourceful"
  );
  expect(skills).toHaveLength(1);
  return createTestSkillState(skills);
}

beforeEach(() => clearDigestCache());

describe("skills/list (SEP-2640)", () => {
  it("returns one entry per skill with a complete digest manifest", async () => {
    const client = await connect(resourcefulState());
    const result = await listSkills(client);

    expect(result.skills).toHaveLength(1);
    const entry = result.skills[0];
    const skillDir = path.join(FIXTURES_DIR, "with-resources");

    expect(entry.uri).toBe("skill://test/resourceful/SKILL.md");
    expect(entry.resources).toEqual([
      {
        uri: "skill://test/resourceful/SKILL.md",
        digest: sha256(path.join(skillDir, "SKILL.md")),
        size: fs.statSync(path.join(skillDir, "SKILL.md")).size,
      },
      {
        uri: "skill://test/resourceful/scripts/example.py",
        digest: sha256(path.join(skillDir, "scripts", "example.py")),
        size: fs.statSync(path.join(skillDir, "scripts", "example.py")).size,
      },
      {
        uri: "skill://test/resourceful/templates/config.json",
        digest: sha256(path.join(skillDir, "templates", "config.json")),
        size: fs.statSync(path.join(skillDir, "templates", "config.json")).size,
      },
    ]);
  });

  it("carries the SKILL.md frontmatter verbatim", async () => {
    const client = await connect(resourcefulState());
    const { skills } = await listSkills(client);

    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "with-resources", "SKILL.md"), "utf-8");
    const yaml = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(skills[0].frontmatter).toEqual(parseYaml(yaml));
    expect(skills[0].frontmatter.name).toBe("resourceful");
  });

  it("omits ttlMs and cacheScope on a pre-2026-07-28 connection", async () => {
    const client = await connect(resourcefulState());
    const result = await listSkills(client);
    expect(result).not.toHaveProperty("ttlMs");
    expect(result).not.toHaveProperty("cacheScope");
  });

  it("reads the live skill map on every request", async () => {
    const state = resourcefulState();
    const client = await connect(state);
    expect((await listSkills(client)).skills).toHaveLength(1);

    state.skillMap = new Map();
    expect((await listSkills(client)).skills).toHaveLength(0);
  });

  it("paginates in URI order and never splits an entry", async () => {
    const a = bundledSkill("a");
    const b = bundledSkill("b", { "x.md": "x" });
    const client = await connect(createTestSkillState([b, a]), (server, state) =>
      registerSkillMethods(server, state, { pageSize: 1 })
    );

    const first = await listSkills(client);
    expect(first.skills.map((s) => s.uri)).toEqual(["skill://a/SKILL.md"]);
    expect(first.nextCursor).toBeDefined();

    const second = await listSkills(client, first.nextCursor);
    expect(second.skills.map((s) => s.uri)).toEqual(["skill://b/SKILL.md"]);
    expect(second.skills[0].resources).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
  });

  it("neither skips nor repeats a skill when the map changes between pages", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => bundledSkill(n));
    const state = createTestSkillState([a, b, c, d]);
    const client = await connect(state, (server, s) =>
      registerSkillMethods(server, s, { pageSize: 2 })
    );

    const first = await listSkills(client);
    expect(first.skills.map((s) => s.uri)).toEqual(["skill://a/SKILL.md", "skill://b/SKILL.md"]);

    // A refresh removes a skill from the front and adds one at the end.
    state.skillMap = createTestSkillState([b, c, d, bundledSkill("e")]).skillMap;

    const second = await listSkills(client, first.nextCursor);
    expect(second.skills.map((s) => s.uri)).toEqual(["skill://c/SKILL.md", "skill://d/SKILL.md"]);
    const third = await listSkills(client, second.nextCursor);
    expect(third.skills.map((s) => s.uri)).toEqual(["skill://e/SKILL.md"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("rejects a malformed cursor with -32602", async () => {
    const client = await connect(resourcefulState());
    await expect(listSkills(client, "not-a-cursor")).rejects.toMatchObject({ code: -32602 });
  });

  it("skips a skill whose SKILL.md vanished since the last refresh", async () => {
    const gone = createTestSkill({
      name: "gone",
      baseName: "gone",
      path: "/nonexistent/gone/SKILL.md",
      source: BUNDLED_SKILL_SOURCE,
    });
    const client = await connect(createTestSkillState([gone]));
    expect((await listSkills(client)).skills).toHaveLength(0);
  });
});

describe("skills/get (SEP-2640)", () => {
  it("returns the same entry skills/list does", async () => {
    const client = await connect(resourcefulState());
    const listed = (await listSkills(client)).skills[0];
    const got = await getSkill(client, listed.uri);
    expect(got.skill).toEqual(listed);
    expect(got).not.toHaveProperty("ttlMs");
  });

  it("returns -32602 for a URI that is not a served skill", async () => {
    const client = await connect(resourcefulState());
    await expect(getSkill(client, "skill://test/nope/SKILL.md")).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      getSkill(client, "skill://test/resourceful/scripts/example.py")
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("returns -32603 for a served skill whose SKILL.md cannot be read", async () => {
    const gone = createTestSkill({
      name: "gone",
      baseName: "gone",
      path: "/nonexistent/gone/SKILL.md",
      source: BUNDLED_SKILL_SOURCE,
    });
    const client = await connect(createTestSkillState([gone]));
    await expect(getSkill(client, "skill://gone/SKILL.md")).rejects.toMatchObject({ code: -32603 });
  });
});

describe("buildSkillEntry", () => {
  it("re-hashes a file after it changes and reuses the digest otherwise", () => {
    const skill = bundledSkill("cached", { "notes.md": "one" });
    const notes = path.join(path.dirname(skill.path), "notes.md");

    const before = buildSkillEntry(skill)!;
    const again = buildSkillEntry(skill)!;
    expect(again).toEqual(before);

    fs.writeFileSync(notes, "two changed");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(notes, past, past);
    const after = buildSkillEntry(skill)!;
    const ref = (after.resources as { uri: string; digest: string; size: number }[]).find((r) =>
      r.uri.endsWith("/notes.md")
    )!;
    expect(ref.digest).toBe(sha256(notes));
    expect(ref.size).toBe(Buffer.byteLength("two changed"));
    expect(ref.digest).not.toBe(
      (before.resources as { uri: string; digest: string }[]).find((r) =>
        r.uri.endsWith("/notes.md")
      )!.digest
    );
  });

  it("excludes hidden files from the manifest", () => {
    const skill = bundledSkill("hidden", { ".env": "SECRET=1", "ok.md": "fine" });
    const uris = (buildSkillEntry(skill)!.resources as { uri: string }[]).map((r) => r.uri);
    expect(uris).toEqual(["skill://hidden/SKILL.md", "skill://hidden/ok.md"]);
  });

  it("accepts trailing whitespace on the frontmatter delimiter lines", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-fm-"));
    fs.mkdirSync(path.join(parent, "spaced"));
    fs.writeFileSync(
      path.join(parent, "spaced", "SKILL.md"),
      "---  \nname: spaced\ndescription: has trailing spaces\n---\t\nbody\n---\nnot frontmatter\n"
    );
    const skills = discoverSkills(parent, BUNDLED_SKILL_SOURCE);
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill.frontmatter).toEqual({ name: "spaced", description: "has trailing spaces" });
  });
});

describe("digest cache", () => {
  it("prunes entries for files outside the current skill directories", () => {
    const kept = bundledSkill("kept", { "k.md": "k" });
    const dropped = bundledSkill("dropped", { "d.md": "d" });
    buildSkillEntry(kept);
    buildSkillEntry(dropped);
    const droppedFile = path.join(path.dirname(dropped.path), "d.md");
    const keptFile = path.join(path.dirname(kept.path), "k.md");

    pruneDigestCache(createTestSkillState([kept]));

    // A pruned path is re-hashed on next access; a kept one is served from cache.
    fs.unlinkSync(droppedFile);
    expect(fileDigest(droppedFile)).toBeNull();
    expect(fileDigest(keptFile)).not.toBeNull();
  });
});

describe("resources/read stays within the manifest", () => {
  it("refuses a hidden file even though it exists on disk", async () => {
    const client = await connect(createTestSkillState([bundledSkill("hidden", { ".env": "SECRET=1" })]));
    await expect(client.readResource({ uri: "skill://hidden/.env" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("refuses a file under node_modules and a directory", async () => {
    const client = await connect(
      createTestSkillState([bundledSkill("nm", { "node_modules/x/index.js": "x", "docs/a.md": "a" })])
    );
    await expect(
      client.readResource({ uri: "skill://nm/node_modules/x/index.js" })
    ).rejects.toMatchObject({ code: -32602 });
    await expect(client.readResource({ uri: "skill://nm/docs" })).rejects.toMatchObject({
      code: -32602,
    });
    const ok = await client.readResource({ uri: "skill://nm/docs/a.md" });
    expect(ok.contents[0]).toMatchObject({ text: "a" });
  });

  it("serves a binary file as a base64 blob whose bytes match the manifest", async () => {
    // Bytes that are not valid UTF-8, so a text decode would change them.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00]);
    const skill = bundledSkill("bin");
    const skillDir = path.dirname(skill.path);
    fs.writeFileSync(path.join(skillDir, "logo.png"), png);
    fs.writeFileSync(path.join(skillDir, "font.ttf"), png);
    const client = await connect(createTestSkillState([skill]));

    const entry = (await listSkills(client)).skills[0];
    const ref = (entry.resources as { uri: string; digest: string; size: number }[]).find((r) =>
      r.uri.endsWith("/logo.png")
    )!;
    expect(ref.size).toBe(png.length);

    for (const name of ["logo.png", "font.ttf"]) {
      const read = await client.readResource({ uri: `skill://bin/${name}` });
      const content = read.contents[0] as { blob?: string; text?: string; mimeType?: string };
      expect(content.text).toBeUndefined();
      const bytes = Buffer.from(content.blob!, "base64");
      expect(bytes.equals(png)).toBe(true);
      expect(sha256Digest(bytes)).toBe(ref.digest);
    }
    const listed = await client.listResources();
    expect(listed.resources.find((r) => r.uri === "skill://bin/logo.png")!.mimeType).toBe("image/png");
  });

  it("returns -32602 for a URI no skill serves and for malformed percent-encoding", async () => {
    const client = await connect(resourcefulState());
    await expect(
      client.readResource({ uri: "skill://test/nope/SKILL.md" })
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      client.readResource({ uri: "skill://test/resourceful/%E0%A4%A" })
    ).rejects.toMatchObject({ code: -32602 });
  });
});
