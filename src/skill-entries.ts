/**
 * SEP-2640 skill entries: the `skills/list` and `skills/get` methods.
 *
 * Skilljack rebuilds its skill map whenever a source changes, so both
 * handlers read `skillState` on every request. Method names, wire schemas,
 * limits and the digest helper come from `@olaservo/ext-skills`. Entries are
 * assembled here so their URIs are byte-identical to the ones `resources/list`
 * advertises: the SDK's own entry builder does not percent-encode path
 * segments, and skilljack does.
 *
 * Pagination is keyed on the last URI of the previous page (entries are
 * sorted by URI), so a refresh between two page requests neither skips nor
 * repeats a skill. Offset cursors, which the SDK uses over its static
 * snapshot, would.
 *
 * Per-file digests are cached by (path, mtime, size), so a listing re-hashes
 * only files that changed since the last request.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  SKILLS_LIST_METHOD,
  SKILLS_GET_METHOD,
  SkillsListParamsSchema,
  SkillsListResultSchema,
  SkillsGetParamsSchema,
  SkillsGetResultSchema,
  MAX_RESOURCES_PER_SKILL,
  MAX_TOTAL_SIZE_PER_SKILL,
  sha256Digest,
} from "@olaservo/ext-skills/server";
import type { z } from "zod";
import { SkillMetadata, buildSkillResourceUri } from "./skill-discovery.js";
import { SkillState, listSkillFiles } from "./skill-tool.js";

// Wire types derived from the SDK's schemas, so handler results satisfy the
// loose-object shape setRequestHandler validates against.
type SkillsListResult = z.output<typeof SkillsListResultSchema>;
type SkillsGetResult = z.output<typeof SkillsGetResultSchema>;
export type SkillEntry = SkillsListResult["skills"][number];
export type SkillResourceRef = Extract<SkillEntry["resources"], unknown[]>[number];

/** Entries per `skills/list` page. */
export const DEFAULT_SKILLS_PAGE_SIZE = 50;

export interface SkillMethodOptions {
  /** Entries per `skills/list` page. Default {@link DEFAULT_SKILLS_PAGE_SIZE}. */
  pageSize?: number;
  /** SEP-2549 freshness hint. Emitted on 2026-07-28+ connections only. Default 0. */
  ttlMs?: number;
  /** SEP-2549 cache scope. Emitted on 2026-07-28+ connections only. Default "private". */
  cacheScope?: "public" | "private";
}

interface DigestCacheEntry {
  mtimeMs: number;
  size: number;
  digest: string;
}

const digestCache = new Map<string, DigestCacheEntry>();

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
  if (resources.length > MAX_RESOURCES_PER_SKILL) {
    problems.push(`${resources.length} resources (limit ${MAX_RESOURCES_PER_SKILL})`);
  }
  if (total > MAX_TOTAL_SIZE_PER_SKILL) {
    problems.push(`${total} bytes total (limit ${MAX_TOTAL_SIZE_PER_SKILL})`);
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
 * advertises and `resources/read` serves. Returns null when SKILL.md is
 * unreadable.
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
  return { uri, frontmatter: skill.frontmatter, resources };
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
function decodeCursor(cursor: string | undefined): string | undefined {
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

function encodeCursor(after: string): string {
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
 * Entry for the skill whose SKILL.md URI is `uri`. Throws -32602 when no
 * skill is served there and -32603 when one is but its SKILL.md cannot be
 * read right now.
 */
export function getSkillEntry(skillState: SkillState, uri: string): SkillEntry {
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
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
}

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CACHING_MIN_PROTOCOL = "2026-07-28";

/**
 * `ttlMs`/`cacheScope` exist only from protocol 2026-07-28, where the request
 * envelope carries the negotiated version. Earlier connections have no
 * envelope and get neither field.
 */
function cachingAttributes(
  ctx: unknown,
  options: SkillMethodOptions
): { ttlMs?: number; cacheScope?: "public" | "private" } {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq
    ?.envelope;
  const version = envelope?.[PROTOCOL_VERSION_META_KEY];
  if (typeof version !== "string" || version < CACHING_MIN_PROTOCOL) return {};
  return { ttlMs: options.ttlMs ?? 0, cacheScope: options.cacheScope ?? "private" };
}

/**
 * Register `skills/list` and `skills/get` on the server. The extension
 * capability itself is declared where the server is constructed.
 */
export function registerSkillMethods(
  server: McpServer,
  skillState: SkillState,
  options: SkillMethodOptions = {}
): void {
  const pageSize = options.pageSize ?? DEFAULT_SKILLS_PAGE_SIZE;

  server.server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: SkillsListParamsSchema, result: SkillsListResultSchema },
    async (params, ctx): Promise<SkillsListResult> => ({
      ...listSkillEntries(skillState, params.cursor, pageSize),
      ...cachingAttributes(ctx, options),
    })
  );

  server.server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: SkillsGetParamsSchema, result: SkillsGetResultSchema },
    async (params, ctx): Promise<SkillsGetResult> => ({
      skill: getSkillEntry(skillState, params.uri),
      ...cachingAttributes(ctx, options),
    })
  );
}
