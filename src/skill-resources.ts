/**
 * MCP Resource registration for skill-based resources, aligned with SEP-2640
 * (Skills Extension). The `skill://` namespace, `skills/list`, `skills/get`
 * and `resources/directory/read` are served by the SDK's `SkillsExtension`
 * over a `SkillSource` built here from the live `skillState` (entries come
 * from skill-entries.ts). The SDK owns the wire: the `skill://{+path}`
 * resource template, the capability declaration and the `ttlMs` /
 * `cacheScope` attributes on 2026-07-28 connections.
 *
 * URI Scheme:
 *   skill://<skill-path>/SKILL.md   -> Each skill's SKILL.md (listed in resources/list)
 *   skill://<skill-path>/<file>     -> Individual files inside a skill (listed in
 *                                      resources/list at lower priority than SKILL.md)
 *   skill://<skill-path>[/<dir>]    -> A directory, readable with resources/directory/read
 *   skill://index.json              -> Pre-v1 discovery index (application/json), kept
 *                                      for clients that predate skills/list
 *
 * <skill-path> is computed by getSkillPath(): "<prefix>/<baseName>" for prefixed
 * skills (final segment always equals frontmatter `name`), or just "<baseName>"
 * for bundled skills with empty prefix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { Resource } from "@modelcontextprotocol/server";
import { DIRECTORY_MIME_TYPE, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { SkillReadResult, SkillSource, SkillWarning } from "@modelcontextprotocol/server/ext/skills";
import {
  DEFAULT_SKILLS_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  getSkillEntry,
  listSkillEntries,
} from "./skill-entries.js";
import {
  SkillMetadata,
  loadSkillContent,
  getResourceAnnotations,
  getSkillPath,
  buildSkillResourceUri,
  parseSkillResourceUri,
  buildSkillIndex,
} from "./skill-discovery.js";
import {
  MAX_FILE_SIZE,
  isListedSkillDir,
  isListedSkillFile,
  listSkillFiles,
  readSkillFile,
  skillFileMimeType,
  SkillState,
} from "./skill-tool.js";

export interface SkillsExtensionOptions {
  /** Entries per `skills/list` and `resources/directory/read` page. Default {@link DEFAULT_SKILLS_PAGE_SIZE}. */
  pageSize?: number;
}

/**
 * Register skill resources with the MCP server: the discovery index and the
 * skills extension. One extension instance may be attached to any number of
 * servers (the stdio and HTTP factories build a fresh server per connection
 * or request), so callers that build servers repeatedly pass theirs in.
 */
export function registerSkillResources(
  server: McpServer,
  skillState: SkillState,
  extension: SkillsExtension = createSkillsExtension(skillState)
): void {
  registerSkillIndexResource(server, skillState);
  extension.attach(server);
}

/**
 * The skills extension over `skillState`. `strict` stays off: a skill whose
 * entry breaks the Agent Skills rules (for example a name with uppercase
 * letters) is dropped from `skills/list` with one warning instead of taking
 * the server down, and the tools and prompts still serve it by name.
 */
export function createSkillsExtension(
  skillState: SkillState,
  options: SkillsExtensionOptions = {}
): SkillsExtension {
  const warned = new Set<string>();
  const onWarning = ({ path: at, message }: SkillWarning) => {
    const key = `${at}: ${message}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.error(`Skills extension: ${key}`);
  };
  return new SkillsExtension({ source: createSkillSource(skillState, options), onWarning });
}

/**
 * Register the SEP-2640 discovery index at skill://index.json. It is not a
 * skill file, so it does not collide with the extension's `skill://{+path}`
 * template; fixed resources are matched before templates.
 */
function registerSkillIndexResource(
  server: McpServer,
  skillState: SkillState
): void {
  server.registerResource(
    "Skill Index",
    "skill://index.json",
    {
      mimeType: "application/json",
      description: "SEP-2640 Agent Skills discovery index",
      annotations: { audience: ["assistant", "user"], priority: 0.5 },
    },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(buildSkillIndex(skillState.skillMap), null, 2),
        },
      ],
    })
  );
}

/** URI of a directory inside a skill; the skill root has no trailing slash. */
function buildSkillDirectoryUri(skill: SkillMetadata, dirRelPath: string): string {
  return dirRelPath === "" ? `skill://${getSkillPath(skill)}` : buildSkillResourceUri(skill, dirRelPath);
}

/**
 * Parse a skill:// URI into a (skill, dirRelPath) pair, where the URI names
 * the skill root (`skill://<skill-path>`) or a directory below it. A trailing
 * slash is not a directory URI (SEP-2640 writes them without one).
 */
function parseSkillDirectoryUri(
  uri: string,
  skillMap: Map<string, SkillMetadata>
): { skill: SkillMetadata; dirRelPath: string } | null {
  const m = uri.match(/^skill:\/\/(.+)$/);
  if (!m || m[1].endsWith("/")) return null;
  let remainder: string;
  try {
    remainder = m[1].split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  const candidates = Array.from(skillMap.values())
    .map((s) => ({ s, p: getSkillPath(s) }))
    .sort((a, b) => b.p.length - a.p.length);
  for (const { s, p } of candidates) {
    if (remainder === p) return { skill: s, dirRelPath: "" };
    if (remainder.startsWith(p + "/")) return { skill: s, dirRelPath: remainder.slice(p.length + 1) };
  }
  return null;
}

/**
 * Direct children of a skill directory, sorted by URI: subdirectories the
 * file walk descends into (as `inode/directory` resources) and the files it
 * lists, plus SKILL.md itself at the root. The same filters as
 * `listSkillFiles` apply, so a directory read never names a file
 * `resources/read` would refuse.
 */
function listDirectoryChildren(skill: SkillMetadata, dirRelPath: string): Resource[] {
  const skillDir = path.dirname(skill.path);
  const dirPath = path.join(skillDir, dirRelPath);
  const children: Resource[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return children;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const rel = dirRelPath === "" ? entry.name : `${dirRelPath}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!isListedSkillDir(skillDir, rel)) continue;
      children.push({ uri: buildSkillDirectoryUri(skill, rel), name: entry.name, mimeType: DIRECTORY_MIME_TYPE });
      continue;
    }
    const abs = path.join(dirPath, entry.name);
    if (abs === skill.path) {
      children.push({
        uri: buildSkillResourceUri(skill, "SKILL.md"),
        name: "SKILL.md",
        mimeType: "text/markdown",
        ...sizeOf(abs),
      });
      continue;
    }
    if (!isListedSkillFile(skillDir, rel)) continue;
    children.push({
      uri: buildSkillResourceUri(skill, rel),
      name: entry.name,
      mimeType: skillFileMimeType(abs, rel),
      ...sizeOf(abs),
    });
  }
  return children.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

function sizeOf(abs: string): { size?: number } {
  try {
    const size = fs.statSync(abs).size;
    return size <= MAX_FILE_SIZE ? { size } : {};
  } catch {
    return {};
  }
}

/**
 * Read a skill file the way `resources/read` serves it. Only SKILL.md and the
 * files the skill's entry lists are served, so a read can never return
 * content the manifest does not cover (hidden files, symlinks, node_modules,
 * files over MAX_FILE_SIZE) and never fails on a file the manifest does list.
 * Anything else is undefined, which the SDK answers with -32602, the code
 * SEP-2640 prescribes for a resource the server does not serve.
 */
function readSkillResource(skillState: SkillState, uri: string): SkillReadResult | undefined {
  let parsed: ReturnType<typeof parseSkillResourceUri> = null;
  try {
    parsed = parseSkillResourceUri(uri, skillState.skillMap);
  } catch {
    // Malformed percent-encoding: an unknown resource.
  }
  if (!parsed) return undefined;
  const { skill, fileRelPath } = parsed;

  if (fileRelPath === "SKILL.md") {
    try {
      return { text: loadSkillContent(skill.path), mimeType: "text/markdown" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to load skill "${skill.baseName}": ${message}`
      );
    }
  }

  const skillDir = path.dirname(skill.path);
  if (!isListedSkillFile(skillDir, fileRelPath)) return undefined;

  // Only bytes that are valid UTF-8 go out as text, so a host hashing what it
  // receives gets the same bytes the entry digests. Anything else is a base64
  // blob, whatever its label says.
  const file = readSkillFile(path.join(skillDir, fileRelPath), fileRelPath);
  return file.text !== undefined
    ? { text: file.text, mimeType: file.mimeType }
    : { bytes: file.bytes, mimeType: file.mimeType };
}

/**
 * What `resources/list` advertises under `skill://`: one SKILL.md resource
 * per skill, then each supporting file below it. Reuses the same enumeration
 * as the skill-resource tool and the entry manifest so every surface agrees
 * on which files are served.
 */
function listSkillResources(skillState: SkillState): Resource[] {
  const resources: Resource[] = [];
  for (const skill of skillState.skillMap.values()) {
    const { annotations, size } = getResourceAnnotations(skill, 0.8);
    const resource: Resource = {
      uri: buildSkillResourceUri(skill, "SKILL.md"),
      name: skill.baseName,
      mimeType: "text/markdown",
      description: skill.description,
      annotations,
    };
    if (size !== undefined) {
      resource.size = size;
    }
    resources.push(resource);

    const skillDir = path.dirname(skill.path);
    // audience/priority are skill-level; lastModified/size must come from
    // each file's own stat (not SKILL.md's), so build fresh per-file
    // annotations rather than sharing one object.
    const { audience, priority } = getResourceAnnotations(skill, 0.3).annotations;
    for (const file of listSkillFiles(skillDir)) {
      const fileResource: Resource = {
        uri: buildSkillResourceUri(skill, file),
        name: `${skill.baseName}/${file}`,
        mimeType: skillFileMimeType(path.resolve(skillDir, file), file),
        description: `Supporting file in ${skill.baseName}`,
        annotations: { audience, priority },
      };
      try {
        const stat = fs.statSync(path.resolve(skillDir, file));
        fileResource.size = stat.size;
        fileResource.annotations!.lastModified = stat.mtime.toISOString();
      } catch {
        // Best-effort size/lastModified; omit if the file can't be stat'd.
      }
      resources.push(fileResource);
    }
  }
  return resources;
}

/**
 * The `SkillSource` the extension serves: every method reads `skillState`
 * at call time, so a refresh is visible on the next request without a
 * reload. Implementing `readDirectory` is what declares `directoryRead`.
 */
export function createSkillSource(
  skillState: SkillState,
  options: SkillsExtensionOptions = {}
): SkillSource {
  const pageSize = options.pageSize ?? DEFAULT_SKILLS_PAGE_SIZE;
  return {
    async list({ cursor }) {
      return listSkillEntries(skillState, cursor, pageSize);
    },
    async get(uri) {
      return getSkillEntry(skillState, uri);
    },
    async read(uri) {
      return readSkillResource(skillState, uri);
    },
    async readDirectory(uri, { cursor }) {
      const parsed = parseSkillDirectoryUri(uri, skillState.skillMap);
      if (!parsed) return undefined;
      const { skill, dirRelPath } = parsed;
      if (!isListedSkillDir(path.dirname(skill.path), dirRelPath)) return undefined;
      const all = listDirectoryChildren(skill, dirRelPath);
      const after = decodeCursor(cursor);
      let start = 0;
      if (after !== undefined) {
        start = all.findIndex((r) => r.uri > after);
        if (start === -1) start = all.length;
      }
      const page = all.slice(start, start + pageSize);
      return start + page.length < all.length
        ? { resources: page, nextCursor: encodeCursor(page[page.length - 1].uri) }
        : { resources: page };
    },
    async listResources() {
      return listSkillResources(skillState);
    },
  };
}
