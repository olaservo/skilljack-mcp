/**
 * Well-known agent skills discovery configuration.
 *
 * Implements the `.well-known/agent-skills/` discovery RFC
 * (https://schemas.agentskills.io/discovery/0.2.0/schema.json).
 *
 * Mirrors the shape of github-config.ts: URL detection, parsing,
 * allowlist gating, and cache path computation for a remote source.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isGitHubUrl } from "./github-config.js";

/**
 * Parsed well-known publisher specification.
 *
 * `origin` is `<scheme>://<host>[:<port>]` (no trailing slash).
 * `basePath` is the URL path that contains `/.well-known/agent-skills`,
 * with no trailing slash. Together they form the index base, and
 * `<origin><basePath>/index.json` is the document URL.
 */
export interface WellKnownSpec {
  origin: string;
  basePath: string;
}

/**
 * Well-known-specific configuration from environment variables / config file.
 */
export interface WellKnownConfig {
  pollIntervalMs: number;
  cacheDir: string;
  allowedOrigins: string[];
  maxArtifactBytes: number;
  maxUnpackedBytes: number;
  allowHttp: boolean;
}

/**
 * Default polling interval: 5 minutes (matches GitHub).
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default size caps. Generous enough for typical skills, small enough
 * to bound the impact of a malicious or buggy publisher.
 */
const DEFAULT_MAX_ARTIFACT_MB = 10;
const DEFAULT_MAX_UNPACKED_MB = 50;

/**
 * Default cache directory (sibling to GitHub's cache).
 */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".skilljack", "well-known-cache");

/**
 * Required URL fragment that identifies a well-known agent-skills endpoint.
 */
export const WELL_KNOWN_PATH_FRAGMENT = "/.well-known/agent-skills";

/**
 * Check if a path is a well-known URL.
 *
 * Detection rule: starts with http(s):// AND is not a GitHub URL.
 * The URL does not have to include the well-known path fragment yet —
 * `parseWellKnownUrl()` normalizes it on parse.
 */
export function isWellKnownUrl(urlOrPath: string): boolean {
  if (typeof urlOrPath !== "string") return false;
  if (!/^https?:\/\//i.test(urlOrPath)) return false;
  return !isGitHubUrl(urlOrPath);
}

/**
 * Parse a well-known publisher URL into a WellKnownSpec.
 *
 * Supported inputs:
 *   https://example.com
 *   https://example.com/.well-known/agent-skills
 *   https://example.com/.well-known/agent-skills/
 *   https://example.com/.well-known/agent-skills/index.json
 *   https://example.com/some/prefix/.well-known/agent-skills
 *
 * If the input path does not include `/.well-known/agent-skills`, it is
 * appended automatically. A trailing `/index.json` (or trailing slash) is
 * stripped from `basePath`.
 *
 * @throws Error on invalid URL or unsupported scheme.
 */
export function parseWellKnownUrl(url: string, allowHttp = false): WellKnownSpec {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid well-known URL: "${url}"`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported scheme for well-known URL: "${url}"`);
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new Error(
      `Insecure scheme http: rejected for "${url}". ` +
        `Set WELL_KNOWN_ALLOW_HTTP=1 for local development.`
    );
  }

  // Strip trailing /index.json or trailing slashes.
  let pathName = parsed.pathname;
  if (pathName.endsWith("/index.json")) {
    pathName = pathName.slice(0, -"/index.json".length);
  }
  pathName = pathName.replace(/\/+$/, "");

  // Append the well-known fragment if absent.
  if (!pathName.toLowerCase().includes(WELL_KNOWN_PATH_FRAGMENT)) {
    pathName = pathName + WELL_KNOWN_PATH_FRAGMENT;
  }

  // Normalize: ensure leading slash, no trailing slash.
  if (!pathName.startsWith("/")) pathName = "/" + pathName;
  pathName = pathName.replace(/\/+$/, "");

  const origin = `${parsed.protocol}//${parsed.host}`;
  return { origin, basePath: pathName };
}

/**
 * Check if a well-known origin is allowed by the allowlist.
 *
 * Like the GitHub allowlist, an empty allowlist denies all by default
 * for safety — well-known publishers can serve arbitrary code into the
 * agent's context.
 *
 * Comparison is case-insensitive on the host and exact on scheme/port.
 */
export function isOriginAllowed(spec: WellKnownSpec, config: WellKnownConfig): boolean {
  if (config.allowedOrigins.length === 0) {
    return false;
  }
  const target = spec.origin.toLowerCase();
  return config.allowedOrigins.some((allowed) => allowed.toLowerCase() === target);
}

/**
 * Parse a comma-separated list from an environment variable.
 */
function parseCommaList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Path to the shared config file (same file used by skill-config / github-config).
 */
const CONFIG_FILE_PATH = path.join(os.homedir(), ".skilljack", "config.json");

/**
 * Load the well-known allowed-origin list from the shared config file.
 */
function loadAllowedOriginsFromConfig(): string[] {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const content = fs.readFileSync(CONFIG_FILE_PATH, "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.wellKnownAllowedOrigins)) {
        return parsed.wellKnownAllowedOrigins.filter(
          (o: unknown): o is string => typeof o === "string"
        );
      }
    }
  } catch {
    // Ignore errors reading config file.
  }
  return [];
}

/**
 * Parse a positive integer environment variable, falling back to a default.
 */
function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Get well-known configuration from environment variables and config file.
 *
 * Environment variables:
 *   WELL_KNOWN_POLL_INTERVAL_MS - Polling interval (0 disables, default 300000)
 *   WELL_KNOWN_ALLOWED_ORIGINS - Comma-separated allowed origins (env overrides config)
 *   WELL_KNOWN_MAX_ARTIFACT_MB - Per-artifact size cap (default 10)
 *   WELL_KNOWN_MAX_UNPACKED_MB - Per-archive uncompressed cap (default 50)
 *   WELL_KNOWN_ALLOW_HTTP - When "1"/"true"/"yes", permit http:// origins (dev only)
 *   SKILLJACK_CACHE_DIR - Override cache directory base
 */
export function getWellKnownConfig(): WellKnownConfig {
  const envOrigins = parseCommaList(process.env.WELL_KNOWN_ALLOWED_ORIGINS);
  const configOrigins = loadAllowedOriginsFromConfig();

  const allowHttpRaw = process.env.WELL_KNOWN_ALLOW_HTTP?.toLowerCase();
  const allowHttp = allowHttpRaw === "1" || allowHttpRaw === "true" || allowHttpRaw === "yes";

  const cacheBase = process.env.SKILLJACK_CACHE_DIR;
  // SKILLJACK_CACHE_DIR is shared with GitHub. If set, place the well-known
  // cache underneath it as a sibling sub-namespace.
  const cacheDir = cacheBase
    ? path.join(cacheBase, "well-known")
    : DEFAULT_CACHE_DIR;

  const maxArtifactMb = parseIntEnv(process.env.WELL_KNOWN_MAX_ARTIFACT_MB, DEFAULT_MAX_ARTIFACT_MB);
  const maxUnpackedMb = parseIntEnv(process.env.WELL_KNOWN_MAX_UNPACKED_MB, DEFAULT_MAX_UNPACKED_MB);

  return {
    pollIntervalMs: parseIntEnv(process.env.WELL_KNOWN_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    cacheDir,
    allowedOrigins: envOrigins.length > 0 ? envOrigins : configOrigins,
    maxArtifactBytes: maxArtifactMb * 1024 * 1024,
    maxUnpackedBytes: maxUnpackedMb * 1024 * 1024,
    allowHttp,
  };
}

/**
 * Slugify a URL path/host segment for use as a filesystem path.
 * Replaces unsafe characters and collapses runs.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compute a unique filesystem-safe key for a well-known publisher.
 * Combines the host (with port) and a slug of the base path.
 */
export function getWellKnownCacheKey(spec: WellKnownSpec): string {
  const url = new URL(spec.origin);
  const hostKey = slugify(url.host) || "unknown-host";
  // Drop the well-known fragment from the base path before slugging — it's
  // shared by all publishers and adds no disambiguation.
  let pathPart = spec.basePath;
  const fragmentIdx = pathPart.toLowerCase().indexOf(WELL_KNOWN_PATH_FRAGMENT);
  if (fragmentIdx !== -1) {
    pathPart = pathPart.slice(0, fragmentIdx);
  }
  const pathSlug = slugify(pathPart);
  return pathSlug ? `${hostKey}_${pathSlug}` : hostKey;
}

/**
 * Get the cache root for a well-known publisher.
 */
export function getWellKnownCachePath(spec: WellKnownSpec, cacheDir: string): string {
  return path.join(cacheDir, getWellKnownCacheKey(spec));
}

/**
 * Path to the cached index.json document.
 */
export function getWellKnownIndexPath(spec: WellKnownSpec, cacheDir: string): string {
  return path.join(getWellKnownCachePath(spec, cacheDir), "index.json");
}

/**
 * Path to the cached metadata sidecar (ETag/Last-Modified hints).
 */
export function getWellKnownMetaPath(spec: WellKnownSpec, cacheDir: string): string {
  return path.join(getWellKnownCachePath(spec, cacheDir), ".index-meta.json");
}

/**
 * Path to a per-skill subdirectory under the publisher's cache root.
 */
export function getWellKnownSkillPath(
  spec: WellKnownSpec,
  skillName: string,
  cacheDir: string
): string {
  return path.join(getWellKnownCachePath(spec, cacheDir), "skills", skillName);
}

/**
 * Compute the URL for the publisher's index.json document.
 */
export function getWellKnownIndexUrl(spec: WellKnownSpec): string {
  return `${spec.origin}${spec.basePath}/index.json`;
}

/**
 * Resolve an entry's `url` field against the index URL per RFC 3986.
 * Supports absolute, path-absolute, and relative URLs.
 */
export function resolveArtifactUrl(spec: WellKnownSpec, entryUrl: string): string {
  const indexUrl = getWellKnownIndexUrl(spec);
  return new URL(entryUrl, indexUrl).toString();
}

/**
 * Display name for UI / logging.
 */
export function getWellKnownDisplayName(spec: WellKnownSpec): string {
  return `${spec.origin}${spec.basePath}`;
}

/**
 * Prefix used to namespace skill names from this publisher (mirrors the
 * `owner-repo` GitHub prefix).
 */
export function getWellKnownPrefix(spec: WellKnownSpec): string {
  return getWellKnownCacheKey(spec);
}
