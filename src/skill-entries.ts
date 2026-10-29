/**
 * SEP-2640 skill entries: what `skills/list` and `skills/get` return.
 *
 * Skilljack rebuilds its skill map whenever a source changes, so entries are
 * built from `skillState` on every request and handed to the SDK's skills
 * extension through the `SkillSource` in skill-resources.ts. The SDK owns the
 * wire shape (method names, schemas, `ttlMs` / `cacheScope`); this module
 * owns which files an entry lists and their digests. Entries are assembled
 * here so their URIs are byte-identical to the ones `resources/list`
 * advertises: the SDK's own catalog builder does not percent-encode path
 * segments the way skilljack does.
 *
 * Pagination is keyed on the last URI of the previous page (entries are
 * sorted by URI), so a refresh between two page requests neither skips nor
 * repeats a skill.
 *
 * Per-file digests are cached by (path, mtime, size), so a listing re-hashes
 * only files that changed since the last request.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { SKILL_LIMITS } from "@modelcontextprotocol/server/ext/skills";
import type { Skill, SkillResourceEntry } from "@modelcontextprotocol/server/ext/skills";
import { SkillMetadata, buildSkillResourceUri } from "./skill-discovery.js";
import { SkillState, listSkillFiles } from "./skill-tool.js";

export type SkillEntry = Skill;
export type SkillResourceRef = SkillResourceEntry;

/** Entries per `skills/list` page. */
export const DEFAULT_SKILLS_PAGE_SIZE = 50;

interface DigestCacheEntry {
  mtimeMs: number;
  size: number;
  digest: string;
}

const digestCache = new Map<string, DigestCacheEntry>();

/** `sha256:` + lowercase hex digest of `bytes`, the SEP-2640 digest form. */
export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Digest and byte size of a file, re-hashed only when its mtime or size
 * changed since the last call. Returns null for anything that is not a
 * readable regular file.
 */
export function fileDigest(absPath: string): DigestCacheEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = digestCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  const entry = { mtimeMs: stat.mtimeMs, size: bytes.length, digest: sha256Digest(bytes) };
  digestCache.set(absPath, entry);
  return entry;
}

/** Drop every cached digest. Exposed for tests. */
export function clearDigestCache(): void {
  digestCache.clear();
}

/**
 * Drop cached digests for files outside every skill directory currently in
 * `skillState`. Called after a refresh so removed or re-synced skills do not
 * leave entries behind for the life of the process.
 */
export function pruneDigestCache(skillState: SkillState): void {
  const dirs = new Set<string>();
  for (const skill of skillState.skillMap.values()) {
    dirs.add(path.dirname(skill.path));
  }
  for (const key of digestCache.keys()) {
    let keep = false;
    for (const dir of dirs) {
      if (key.startsWith(dir + path.sep)) {
        keep = true;
        break;
      }
    }
    if (!keep) digestCache.delete(key);
  }
}

const limitWarned = new Set<string>();

function warnIfOverLimits(uri: string, resources: SkillResourceRef[]): void {
  const total = resources.reduce((n, r) => n + r.size, 0);
  const problems: string[] = [];
  if (resources.length > SKILL_LIMITS.files) {
    problems.push(`${resources.length} resources (limit ${SKILL_LIMITS.files})`);
  }
  if (total > SKILL_LIMITS.bytes) {
    problems.push(`${total} bytes total (limit ${SKILL_LIMITS.bytes})`);
  }
  if (problems.length === 0 || limitWarned.has(uri)) return;
  limitWarned.add(uri);
  console.error(
    `Skill ${uri} exceeds the SEP-2640 per-skill limits: ${problems.join(", ")}. ` +
      `Conforming hosts are not required to load it.`
  );
}

/** URI of a skill's SKILL.md, which is also the skill's entry URI. */
export function skillEntryUri(skill: SkillMetadata): string {
  return buildSkillResourceUri(skill, "SKILL.md");
}

/**
 * Build a skill's entry. `resources` lists SKILL.md first, then every file
 * `listSkillFiles` enumerates, which is the same set `resources/list`
 * advertises and `resources/read` serves (files over MAX_FILE_SIZE are in
 * neither, so the manifest never names a file a read would refuse). Returns
 * null when SKILL.md is unreadable.
 */
export function buildSkillEntry(skill: SkillMetadata): SkillEntry | null {
  const md = fileDigest(skill.path);
  if (!md) return null;

  const skillDir = path.dirname(skill.path);
  const uri = skillEntryUri(skill);
  const resources: SkillResourceRef[] = [{ uri, digest: md.digest, size: md.size }];
  for (const rel of listSkillFiles(skillDir)) {
    const f = fileDigest(path.join(skillDir, rel));
    if (!f) continue;
    resources.push({ uri: buildSkillResourceUri(skill, rel), digest: f.digest, size: f.size });
  }
  warnIfOverLimits(uri, resources);
  return {
    uri,
    frontmatter: skill.frontmatter as SkillEntry["frontmatter"],
    resources,
  };
}

function compareUris(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every skill in `skillState` with its entry URI, sorted by URI. */
function sortedSkills(skillState: SkillState): Array<{ uri: string; skill: SkillMetadata }> {
  return Array.from(skillState.skillMap.values(), (skill) => ({ uri: skillEntryUri(skill), skill })).sort(
    (a, b) => compareUris(a.uri, b.uri)
  );
}

/** Cursor payload: the URI of the last entry on the previous page. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { after?: unknown }).after === "string") {
      return (parsed as { after: string }).after;
    }
  } catch {
    // fall through
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid cursor: ${cursor}`);
}

export function encodeCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), "utf-8").toString("base64");
}

/**
 * One page of entries, sorted by URI. Entries are built only for the page
 * returned. `nextCursor` is set when more skills follow.
 */
export function listSkillEntries(
  skillState: SkillState,
  cursor?: string,
  pageSize: number = DEFAULT_SKILLS_PAGE_SIZE
): { skills: SkillEntry[]; nextCursor?: string } {
  const all = sortedSkills(skillState);
  const after = decodeCursor(cursor);
  let start = 0;
  if (after !== undefined) {
    start = all.findIndex((x) => compareUris(x.uri, after) > 0);
    if (start === -1) start = all.length;
  }
  const page = all.slice(start, start + pageSize);
  const skills: SkillEntry[] = [];
  for (const { skill } of page) {
    const entry = buildSkillEntry(skill);
    if (entry) skills.push(entry);
  }
  const hasMore = start + page.length < all.length;
  return hasMore ? { skills, nextCursor: encodeCursor(page[page.length - 1].uri) } : { skills };
}

/**
 * Entry for the skill whose SKILL.md URI is `uri`, or undefined when no
 * skill is served there (the SDK answers -32602). Throws -32603 when one is
 * but its SKILL.md cannot be read right now.
 */
export function getSkillEntry(skillState: SkillState, uri: string): SkillEntry | undefined {
  for (const skill of skillState.skillMap.values()) {
    if (skillEntryUri(skill) !== uri) continue;
    const entry = buildSkillEntry(skill);
    if (!entry) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `SKILL.md for ${uri} could not be read`
      );
    }
    return entry;
  }
  return undefined;
}
