import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "node:crypto";
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
} from "@olaservo/ext-skills/server";
import { registerSkillResources } from "./skill-resources.js";
import {
  buildSkillEntry,
  clearDigestCache,
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
  return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

/** The with-resources fixture discovered under a "test" prefix. */
function withResourcesState(): SkillState {
  const skills = discoverSkills(FIXTURES_DIR, createTestSource()).filter(
    (s) => s.baseName === "resourceful"
  );
  expect(skills).toHaveLength(1);
  return createTestSkillState(skills);
}

beforeEach(() => clearDigestCache());

describe("skills/list (SEP-2640)", () => {
  it("returns one entry per skill with a complete digest manifest", async () => {
    const client = await connect(withResourcesState());
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
    const client = await connect(withResourcesState());
    const { skills } = await listSkills(client);

    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "with-resources", "SKILL.md"), "utf-8");
    const yaml = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(skills[0].frontmatter).toEqual(parseYaml(yaml));
    expect(skills[0].frontmatter.name).toBe("resourceful");
  });

  it("omits ttlMs and cacheScope on a pre-2026-07-28 connection", async () => {
    const client = await connect(withResourcesState());
    const result = await listSkills(client);
    expect(result).not.toHaveProperty("ttlMs");
    expect(result).not.toHaveProperty("cacheScope");
  });

  it("reads the live skill map on every request", async () => {
    const state = withResourcesState();
    const client = await connect(state);
    expect((await listSkills(client)).skills).toHaveLength(1);

    state.skillMap = new Map();
    expect((await listSkills(client)).skills).toHaveLength(0);
  });

  it("paginates with an opaque cursor and never splits an entry", async () => {
    const a = createTestSkill({
      name: "a",
      baseName: "a",
      path: makeTempSkill({ "SKILL.md": "---\nname: a\ndescription: A\n---\n" }),
      source: BUNDLED_SKILL_SOURCE,
    });
    const b = createTestSkill({
      name: "b",
      baseName: "b",
      path: makeTempSkill({ "SKILL.md": "---\nname: b\ndescription: B\n---\n", "x.md": "x" }),
      source: BUNDLED_SKILL_SOURCE,
    });
    const client = await connect(createTestSkillState([a, b]), (server, state) =>
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

  it("rejects a malformed cursor with -32602", async () => {
    const client = await connect(withResourcesState());
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
    const client = await connect(withResourcesState());
    const listed = (await listSkills(client)).skills[0];
    const got = await getSkill(client, listed.uri);
    expect(got.skill).toEqual(listed);
    expect(got).not.toHaveProperty("ttlMs");
  });

  it("returns -32602 for a URI that is not a served skill", async () => {
    const client = await connect(withResourcesState());
    await expect(getSkill(client, "skill://test/nope/SKILL.md")).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      getSkill(client, "skill://test/resourceful/scripts/example.py")
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("buildSkillEntry", () => {
  it("re-hashes a file after it changes and reuses the digest otherwise", () => {
    const skillMd = makeTempSkill({
      "SKILL.md": "---\nname: cached\ndescription: C\n---\n",
      "notes.md": "one",
    });
    const skill = createTestSkill({
      name: "cached",
      baseName: "cached",
      path: skillMd,
      source: BUNDLED_SKILL_SOURCE,
    });
    const notes = path.join(path.dirname(skillMd), "notes.md");

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
    const skillMd = makeTempSkill({
      "SKILL.md": "---\nname: hidden\ndescription: H\n---\n",
      ".env": "SECRET=1",
      "ok.md": "fine",
    });
    const skill = createTestSkill({
      name: "hidden",
      baseName: "hidden",
      path: skillMd,
      source: BUNDLED_SKILL_SOURCE,
    });
    const uris = (buildSkillEntry(skill)!.resources as { uri: string }[]).map((r) => r.uri);
    expect(uris).toEqual(["skill://hidden/SKILL.md", "skill://hidden/ok.md"]);
  });
});

describe("resources/read stays within the manifest", () => {
  it("refuses a hidden file even though it exists on disk", async () => {
    const skillMd = makeTempSkill({
      "SKILL.md": "---\nname: hidden\ndescription: H\n---\n",
      ".env": "SECRET=1",
    });
    const client = await connect(
      createTestSkillState([
        createTestSkill({
          name: "hidden",
          baseName: "hidden",
          path: skillMd,
          source: BUNDLED_SKILL_SOURCE,
        }),
      ])
    );
    await expect(client.readResource({ uri: "skill://hidden/.env" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("returns -32602 for a URI no skill serves", async () => {
    const client = await connect(withResourcesState());
    await expect(
      client.readResource({ uri: "skill://test/nope/SKILL.md" })
    ).rejects.toMatchObject({ code: -32602 });
  });
});
