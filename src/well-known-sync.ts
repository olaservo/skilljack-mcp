/**
 * Well-known agent skills synchronization.
 *
 * Fetches a publisher's `index.json`, verifies SHA-256 digests on every
 * artifact, and writes verified content into a local cache directory that
 * the rest of the server treats as a normal skill source.
 *
 * Mirrors the contract of github-sync.ts (syncRepo / syncAllRepos /
 * hasRemoteUpdates), with HTTP fetch + archive extraction in place of git.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tar from "tar";
import * as yauzl from "yauzl-promise";
import {
  WellKnownSpec,
  assertUrlAllowed,
  getWellKnownCachePath,
  getWellKnownIndexPath,
  getWellKnownIndexUrl,
  getWellKnownMetaPath,
  getWellKnownSkillPath,
  resolveArtifactUrl,
} from "./well-known-config.js";

/**
 * One entry in the publisher's discovery index.
 */
export interface IndexEntry {
  name: string;
  type: "skill-md" | "archive" | string; // Tolerate unknown types so we can skip + warn.
  description: string;
  url: string;
  digest: string;
}

/**
 * Parsed discovery index document.
 */
export interface IndexDocument {
  $schema?: string;
  skills: IndexEntry[];
}

/**
 * Options for sync operations.
 */
export interface SyncOptions {
  cacheDir: string;
  maxArtifactBytes: number;
  maxUnpackedBytes: number;
  /**
   * Allowed publisher origins ("<scheme>://<host>"). Every fetched URL —
   * index, artifact, and redirect target — must match one of these. Required
   * so artifacts can't escape the allowlist the index origin was gated by.
   */
  allowedOrigins: string[];
  /** Permit http:// (dev only); otherwise only https:// is fetched. */
  allowHttp: boolean;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  spec: WellKnownSpec;
  /** Path to the directory that contains per-skill subdirectories. */
  localPath: string;
  /** Whether any artifact was downloaded or removed since last sync. */
  updated: boolean;
  /** Skill names that were successfully written/updated this run. */
  skillsSynced: string[];
  /** Skill names that were intentionally pruned. */
  skillsRemoved: string[];
  /** Per-skill error messages (does not abort the whole sync). */
  skillErrors: Record<string, string>;
  /** Top-level error if the whole sync failed (e.g., index.json fetch). */
  error?: string;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_REDIRECTS = 5;

/**
 * Allowed digest format: sha256:<64 lowercase hex chars>.
 */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Allowed skill name per Agent Skills spec: 1-64 chars, lowercase
 * alphanumeric and single hyphens, no leading/trailing/consecutive hyphens.
 */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/**
 * Schema URIs we know how to consume. Other values produce a warning but
 * the index is still parsed (forward-compat per RFC).
 */
const KNOWN_SCHEMAS = new Set<string>([
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Atomically write a buffer to a file (write-then-rename).
 */
function writeFileAtomic(filePath: string, data: Buffer | string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Recursively remove a directory if it exists.
 */
function rmrf(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fetch a URL with retry and a hard byte cap.
 *
 * Returns the response body (concatenated as a single Buffer) plus the
 * response headers. Aborts mid-stream if the cumulative byte count exceeds
 * `maxBytes`.
 */
/**
 * Read a response body into a Buffer, aborting mid-stream if the cumulative
 * size exceeds maxBytes. Shared by the artifact fetch and the polling
 * update-check so every response body is bounded.
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  url: string
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Body-less response (e.g. HEAD / 304).
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new Error(`Response from ${url} exceeds size cap of ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxBytes: number,
  validateUrl?: (u: string) => void
): Promise<{ body: Buffer; headers: Headers; status: number }> {
  let lastError: unknown = undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Follow redirects manually so each hop's origin/scheme can be
      // re-validated. fetch's default redirect:"follow" would silently chase a
      // 3xx off the allowlist, re-opening the SSRF/bypass the allowlist closes.
      let currentUrl = url;
      let response = await fetch(currentUrl, { ...init, redirect: "manual" });
      let hops = 0;
      while (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break; // e.g. 304 Not Modified — not an actual redirect.
        if (++hops > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        // Throws if the redirect target leaves the allowlist or uses a bad scheme.
        if (validateUrl) validateUrl(currentUrl);
        response = await fetch(currentUrl, { ...init, redirect: "manual" });
      }

      if (!response.ok) {
        // 4xx are not retryable; only retry 5xx and network errors.
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`HTTP ${response.status} ${response.statusText} for ${currentUrl}`);
        }
        lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${currentUrl}`);
      } else {
        const body = await readBodyCapped(response, maxBytes, currentUrl);
        return { body, headers: response.headers, status: response.status };
      }
    } catch (error) {
      lastError = error;
    }

    const isLast = attempt === MAX_RETRIES - 1;
    if (!isLast) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.error(
        `Fetch attempt ${attempt + 1}/${MAX_RETRIES} failed for ${url}, retrying in ${backoff}ms...`
      );
      await sleep(backoff);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Compute SHA-256 of a buffer in `sha256:<hex>` form.
 */
function sha256Digest(buf: Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Throw if the actual digest doesn't equal the expected one.
 */
function verifyDigest(buf: Buffer, expected: string, label: string): void {
  if (!DIGEST_RE.test(expected)) {
    throw new Error(`Malformed digest for ${label}: "${expected}"`);
  }
  const actual = sha256Digest(buf);
  if (actual !== expected) {
    throw new Error(
      `Digest mismatch for ${label}: expected ${expected}, got ${actual}`
    );
  }
}

/**
 * Validate the structural shape of a parsed index document.
 * Throws on missing/invalid required fields. Per-entry warnings about
 * unknown `type` values are returned to the caller.
 */
export function validateIndexDocument(parsed: unknown): IndexDocument {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Index is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.$schema !== undefined && typeof obj.$schema !== "string") {
    throw new Error("`$schema` field must be a string when present");
  }

  if (obj.$schema === undefined) {
    console.error(
      "Well-known: index has no `$schema` field; treating as v0.1.0 (backward compat)"
    );
  } else if (!KNOWN_SCHEMAS.has(obj.$schema)) {
    console.error(
      `Well-known: unrecognized $schema "${obj.$schema}"; attempting to parse anyway`
    );
  }

  if (!Array.isArray(obj.skills)) {
    throw new Error("Index `skills` field must be an array");
  }

  const skills: IndexEntry[] = [];
  for (const raw of obj.skills) {
    if (!raw || typeof raw !== "object") {
      console.error("Well-known: skipping non-object entry in skills array");
      continue;
    }
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const type = typeof e.type === "string" ? e.type : "";
    const description = typeof e.description === "string" ? e.description : "";
    const url = typeof e.url === "string" ? e.url : "";
    const digest = typeof e.digest === "string" ? e.digest : "";

    if (!name || !type || !description || !url || !digest) {
      console.error(
        `Well-known: skipping incomplete entry ${JSON.stringify(name || "<unnamed>")}`
      );
      continue;
    }
    if (!SKILL_NAME_RE.test(name)) {
      console.error(`Well-known: skipping entry with invalid name "${name}"`);
      continue;
    }
    if (!DIGEST_RE.test(digest)) {
      console.error(`Well-known: skipping entry "${name}" with malformed digest`);
      continue;
    }
    skills.push({ name, type, description, url, digest });
  }

  return { $schema: obj.$schema as string | undefined, skills };
}

/**
 * Reject path entries that could escape the destination directory.
 * Used as a tar `filter` and as a per-entry zip check.
 */
function isUnsafeEntryPath(entryPath: string): boolean {
  if (!entryPath) return true;
  // Reject absolute paths and Windows drive letters.
  if (path.isAbsolute(entryPath)) return true;
  if (/^[a-zA-Z]:/.test(entryPath)) return true;
  // Normalize and look for traversal.
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "..") return true;
  }
  return false;
}

/**
 * Detect archive format from the URL. Returns null for unrecognized.
 */
export function archiveFormatFromUrl(url: string): "tar.gz" | "zip" | null {
  const lower = url.toLowerCase().split("?")[0].split("#")[0];
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

/**
 * Extract a tar.gz archive into `destDir`, with safety checks.
 *
 * Rejects: absolute paths, parent traversal, symlinks, hardlinks.
 * Aborts if cumulative uncompressed bytes exceed `maxUnpackedBytes`.
 */
async function extractTarGz(
  buffer: Buffer,
  destDir: string,
  maxUnpackedBytes: number
): Promise<void> {
  ensureDir(destDir);
  // Write to a sibling temp file then extract from disk — `tar.x` with a file
  // path is the most reliable invocation of the library and lets the kernel
  // handle streaming.
  const tmpFile = path.join(destDir, `.archive-${process.pid}-${Date.now()}.tar.gz`);
  let unpacked = 0;
  let aborted = false;

  fs.writeFileSync(tmpFile, buffer);
  try {
    await tar.x({
      file: tmpFile,
      cwd: destDir,
      strict: true,
      preservePaths: false,
      filter: (entryPath: string) => isUnsafeEntryPath(entryPath) ? false : true,
      onentry: (entry: tar.ReadEntry) => {
        // Reject symlinks and hardlinks outright — they're ambiguous and
        // archives almost never need them for an MCP skill.
        const entryType = (entry as { type?: string }).type;
        if (entryType === "SymbolicLink" || entryType === "Link") {
          aborted = true;
          throw new Error(
            `Tar archive contains a ${entryType} (${entry.path}); rejecting for safety`
          );
        }
        // node-tar fires onentry *before* writing the body, so an oversized
        // entry is caught pre-write. This trusts the tar header's declared size
        // (the zip path counts real streamed bytes instead) — acceptable
        // because the compressed input is already bounded by maxArtifactBytes,
        // so a lying header can't inflate beyond that gzip blast radius.
        const size = typeof entry.size === "number" ? entry.size : 0;
        unpacked += size;
        if (unpacked > maxUnpackedBytes) {
          aborted = true;
          throw new Error(
            `Tar archive uncompressed size exceeds cap of ${maxUnpackedBytes} bytes`
          );
        }
      },
    });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
    if (aborted) {
      // Wipe partial extraction so a later sync has a clean slate.
      // (Caller is expected to recreate destDir before next attempt.)
    }
  }
}

/**
 * Unix mode bits for a symlink in zip external file attributes.
 */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/**
 * Extract a zip archive into `destDir`, with safety checks.
 */
async function extractZip(
  buffer: Buffer,
  destDir: string,
  maxUnpackedBytes: number
): Promise<void> {
  ensureDir(destDir);
  const zip = await yauzl.fromBuffer(buffer);
  let unpacked = 0;

  try {
    for await (const entry of zip) {
      const entryName = entry.filename;
      if (isUnsafeEntryPath(entryName)) {
        throw new Error(`Zip entry has unsafe path: "${entryName}"`);
      }
      // Detect symlinks via the Unix file mode packed into the zip's external
      // file attributes (high 16 bits). Note: if yauzl ever renames this field
      // the `?? 0` fallback treats entries as non-symlink — but that is not an
      // escape vector, because a missed symlink entry is written by
      // writeFileAtomic below as a regular file containing the link *target
      // string*, never an actual symlink on disk.
      const externalAttrs =
        (entry as unknown as { externalFileAttributes?: number }).externalFileAttributes ?? 0;
      const unixMode = (externalAttrs >>> 16) & 0xffff;
      if ((unixMode & S_IFMT) === S_IFLNK) {
        throw new Error(`Zip entry "${entryName}" is a symbolic link; rejecting`);
      }

      const isDirEntry = entryName.endsWith("/");
      const targetPath = path.join(destDir, entryName);
      const resolvedDest = path.resolve(destDir);
      const resolvedTarget = path.resolve(targetPath);
      if (!resolvedTarget.startsWith(resolvedDest + path.sep) &&
          resolvedTarget !== resolvedDest) {
        throw new Error(`Zip entry "${entryName}" resolves outside the destination`);
      }

      if (isDirEntry) {
        ensureDir(targetPath);
        continue;
      }

      ensureDir(path.dirname(targetPath));
      const readStream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      let entrySize = 0;

      await new Promise<void>((resolve, reject) => {
        readStream.on("data", (chunk: Buffer) => {
          entrySize += chunk.length;
          unpacked += chunk.length;
          if (unpacked > maxUnpackedBytes) {
            readStream.destroy();
            reject(
              new Error(
                `Zip archive uncompressed size exceeds cap of ${maxUnpackedBytes} bytes`
              )
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        readStream.on("error", reject);
        readStream.on("end", resolve);
      });

      writeFileAtomic(targetPath, Buffer.concat(chunks, entrySize));
    }
  } finally {
    await zip.close();
  }
}

/**
 * Extract an archive (tar.gz or zip) into a destination directory after
 * digest verification has already passed.
 */
async function extractArchive(
  buffer: Buffer,
  destDir: string,
  format: "tar.gz" | "zip",
  maxUnpackedBytes: number
): Promise<void> {
  if (format === "tar.gz") {
    await extractTarGz(buffer, destDir, maxUnpackedBytes);
  } else {
    await extractZip(buffer, destDir, maxUnpackedBytes);
  }
}

/**
 * Load the previously cached index document, if any.
 * Returns null if the cache is missing or unparseable.
 */
function loadCachedIndex(spec: WellKnownSpec, cacheDir: string): IndexDocument | null {
  const indexPath = getWellKnownIndexPath(spec, cacheDir);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const content = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(content);
    return validateIndexDocument(parsed);
  } catch {
    return null;
  }
}

/**
 * Sync a single well-known publisher.
 *
 * The high-level flow:
 *   1. Fetch index.json (with retry).
 *   2. Validate JSON shape and per-entry fields.
 *   3. For each entry:
 *        - if cached digest matches and on-disk artifact exists → skip
 *        - else fetch artifact, verify digest, write/extract atomically
 *   4. Prune skill subdirectories that are no longer in the index.
 *   5. Atomically replace the cached index.json.
 */
export async function syncWellKnown(
  spec: WellKnownSpec,
  options: SyncOptions
): Promise<SyncResult> {
  const cachePath = getWellKnownCachePath(spec, options.cacheDir);
  const skillsRoot = path.join(cachePath, "skills");
  const result: SyncResult = {
    spec,
    localPath: skillsRoot,
    updated: false,
    skillsSynced: [],
    skillsRemoved: [],
    skillErrors: {},
  };

  ensureDir(cachePath);
  ensureDir(skillsRoot);

  // Re-validate every URL we fetch (index, artifacts, redirect targets) against
  // the allowlist and scheme rules — not just the configured index origin.
  const validate = (u: string) => assertUrlAllowed(u, options);

  let indexDoc: IndexDocument;
  try {
    const indexUrl = getWellKnownIndexUrl(spec);
    validate(indexUrl);
    const response = await fetchWithRetry(
      indexUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      options.maxArtifactBytes,
      validate
    );
    const text = response.body.toString("utf-8");
    const parsed = JSON.parse(text);
    indexDoc = validateIndexDocument(parsed);

    // Persist conditional-fetch hints for later HEAD probes.
    const meta = {
      etag: response.headers.get("etag") || null,
      lastModified: response.headers.get("last-modified") || null,
      digest: sha256Digest(response.body),
      fetchedAt: new Date().toISOString(),
    };
    writeFileAtomic(getWellKnownMetaPath(spec, options.cacheDir), JSON.stringify(meta, null, 2));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.error = `Failed to fetch index for ${spec.origin}: ${msg}`;
    console.error(result.error);
    return result;
  }

  const cached = loadCachedIndex(spec, options.cacheDir);
  const cachedByName = new Map<string, IndexEntry>();
  if (cached) {
    for (const e of cached.skills) cachedByName.set(e.name, e);
  }

  const newNames = new Set<string>();

  for (const entry of indexDoc.skills) {
    newNames.add(entry.name);
    const skillDir = getWellKnownSkillPath(spec, entry.name, options.cacheDir);

    try {
      if (entry.type !== "skill-md" && entry.type !== "archive") {
        console.error(
          `Well-known: skipping skill "${entry.name}" with unrecognized type "${entry.type}"`
        );
        continue;
      }

      const skillMdPath = path.join(skillDir, "SKILL.md");
      const cachedEntry = cachedByName.get(entry.name);
      const digestUnchanged = cachedEntry?.digest === entry.digest;
      const artifactPresent = fs.existsSync(skillMdPath);

      if (digestUnchanged && artifactPresent) {
        // Up to date.
        continue;
      }

      const artifactUrl = resolveArtifactUrl(spec, entry.url);
      // The entry's url may be absolute/cross-origin — gate it (and any
      // redirect) on the allowlist before issuing the request, so a malicious
      // publisher can't point it at an internal host (SSRF) or off-allowlist CDN.
      validate(artifactUrl);
      const artifactRes = await fetchWithRetry(
        artifactUrl,
        { method: "GET" },
        options.maxArtifactBytes,
        validate
      );
      verifyDigest(artifactRes.body, entry.digest, `skill "${entry.name}"`);

      // Wipe previous skill dir to avoid stale supporting files.
      rmrf(skillDir);
      ensureDir(skillDir);

      if (entry.type === "skill-md") {
        writeFileAtomic(skillMdPath, artifactRes.body);
      } else {
        // archive
        const format = archiveFormatFromUrl(artifactUrl);
        if (!format) {
          throw new Error(
            `Archive entry "${entry.name}" has unsupported file extension: ${artifactUrl}`
          );
        }
        await extractArchive(artifactRes.body, skillDir, format, options.maxUnpackedBytes);
        if (!fs.existsSync(skillMdPath)) {
          throw new Error(
            `Archive for "${entry.name}" did not contain SKILL.md at the root`
          );
        }
      }

      result.skillsSynced.push(entry.name);
      result.updated = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.skillErrors[entry.name] = msg;
      console.error(`Well-known: failed to sync "${entry.name}": ${msg}`);
      // Discard partially-written content so subsequent reads don't see it.
      rmrf(skillDir);
    }
  }

  // Prune skill subdirectories that disappeared from the index.
  if (cached) {
    for (const e of cached.skills) {
      if (!newNames.has(e.name)) {
        const dir = getWellKnownSkillPath(spec, e.name, options.cacheDir);
        rmrf(dir);
        result.skillsRemoved.push(e.name);
        result.updated = true;
      }
    }
  }

  // Persist the new index last so a crash mid-sync leaves the old index in
  // place (digest comparison on the next run will redo any incomplete work).
  writeFileAtomic(
    getWellKnownIndexPath(spec, options.cacheDir),
    JSON.stringify(indexDoc, null, 2)
  );

  return result;
}

/**
 * Sync multiple publishers sequentially.
 */
export async function syncAllWellKnown(
  specs: WellKnownSpec[],
  options: SyncOptions
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const spec of specs) {
    results.push(await syncWellKnown(spec, options));
  }
  return results;
}

/**
 * Cheaply check whether the publisher's index has changed.
 *
 * Strategy:
 *   1. If we have no cached meta, return true (force full sync).
 *   2. Send a conditional GET (If-None-Match / If-Modified-Since). 304 → no
 *      change; 200 → new body, compare digests.
 *
 * This avoids hashing on the publisher's side and keeps bandwidth low.
 */
export async function hasRemoteUpdates(
  spec: WellKnownSpec,
  options: SyncOptions
): Promise<boolean> {
  const metaPath = getWellKnownMetaPath(spec, options.cacheDir);
  if (!fs.existsSync(metaPath)) return true;

  let meta: { etag: string | null; lastModified: string | null; digest: string | null };
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return true;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (meta.etag) headers["If-None-Match"] = meta.etag;
  if (meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  try {
    const indexUrl = getWellKnownIndexUrl(spec);
    assertUrlAllowed(indexUrl, options);
    // redirect:"manual" so a 3xx doesn't wander off-allowlist here; any real
    // redirect just forces a full sync (which re-validates every hop).
    const res = await fetch(indexUrl, { method: "GET", headers, redirect: "manual" });
    if (res.status === 304) return false;
    if (res.status >= 300 && res.status < 400) return true; // redirect → full sync
    if (!res.ok) return true;

    // Compare digest of new body to the cached digest as a final tie-breaker.
    // Bounded by the same size cap as the main fetch to avoid an unbounded
    // buffer on every poll.
    const body = await readBodyCapped(res, options.maxArtifactBytes, indexUrl);
    const newDigest = sha256Digest(body);
    return newDigest !== meta.digest;
  } catch (error) {
    console.error(
      `Well-known: update check failed for ${spec.origin}: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}
