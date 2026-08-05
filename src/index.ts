#!/usr/bin/env node
/**
 * Skilljack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skilljack-mcp /path/to/skills [/path2 ...]                       # Local directories
 *   skilljack-mcp --static /path/to/skills                           # Static mode (no file watching)
 *   skilljack-mcp github.com/owner/repo                              # GitHub repository
 *   skilljack-mcp https://example.com/.well-known/agent-skills/      # Well-known publisher
 *   skilljack-mcp /local github.com/o/r https://ex.com               # Mixed sources
 *   SKILLS_DIR=/path,github.com/owner/repo skilljack-mcp             # Via environment
 *   SKILLJACK_STATIC=true skilljack-mcp                  # Static mode via env
 *   (or configure local directories via the skill-config UI)
 *
 * Options:
 *   --static  Freeze skills list at startup. Disables file watching and
 *             tools/prompts listChanged notifications. Resource subscriptions
 *             remain fully dynamic.
 */

import { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import chokidar from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, createSkillMap, applyInvocationOverrides, SkillSource, DEFAULT_SKILL_SOURCE, BUNDLED_SKILL_SOURCE, warnLargeSkillCount } from "./skill-discovery.js";
import { registerSkillTool, getToolDescription, getServerInstructions, SkillState, CatalogMode } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts, refreshPrompts, PromptRegistry } from "./skill-prompts.js";
import { startHttpServer } from "./http-transport.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
  refreshSubscriptions,
  SubscriptionManager,
} from "./subscriptions.js";
import { getActiveDirectories, getSkillInvocationOverrides, getStaticModeFromConfig } from "./skill-config.js";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { registerSkillDisplayTool } from "./skill-display-tool.js";
import {
  isGitHubUrl,
  parseGitHubUrl,
  isRepoAllowed,
  getGitHubConfig,
  GitHubRepoSpec,
  getRepoCachePath,
} from "./github-config.js";
import { syncAllRepos, SyncOptions } from "./github-sync.js";
import { createPollingManager } from "./github-polling.js";
import {
  isWellKnownUrl,
  parseWellKnownUrl,
  isOriginAllowed,
  getWellKnownConfig,
  getWellKnownCachePath,
  getWellKnownDisplayName,
  getWellKnownPrefix,
  WellKnownSpec,
} from "./well-known-config.js";
import {
  syncAllWellKnown,
  SyncOptions as WellKnownSyncOptions,
} from "./well-known-sync.js";
import { createWellKnownPollingManager } from "./well-known-polling.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Get the path to bundled skills directory.
 * Resolves relative to the compiled module location.
 */
function getBundledSkillsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // From dist/index.js, go up one level to package root, then into skills/
  return path.resolve(currentDir, "..", "skills");
}

/**
 * Map from directory path to its source information.
 * Used to tag discovered skills with their origin.
 */
interface DirectorySourceMap {
  [dirPath: string]: SkillSource;
}

/**
 * Build a directory-to-source map from current configuration.
 * Maps both main directories and their standard subdirectories.
 *
 * @param localDirs - Local skill directories
 * @param githubSpecs - GitHub repository specifications
 * @param cacheDir - GitHub cache directory path
 * @param wellKnownSpecs - Well-known publisher specifications
 * @param wellKnownCacheDir - Well-known cache directory path
 * @param bundledDir - Optional bundled skills directory
 */
function buildDirectorySourceMap(
  localDirs: string[],
  githubSpecs: GitHubRepoSpec[],
  cacheDir: string,
  wellKnownSpecs: WellKnownSpec[],
  wellKnownCacheDir: string,
  bundledDir?: string
): DirectorySourceMap {
  const map: DirectorySourceMap = {};

  // Map local directories
  for (const dir of localDirs) {
    const source: SkillSource = {
      type: "local",
      displayName: "Local",
      prefix: path.basename(dir),
    };
    map[dir] = source;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(dir, subdir)] = source;
    }
  }

  // Map GitHub cache directories
  for (const spec of githubSpecs) {
    const cachePath = getRepoCachePath(spec, cacheDir);
    const source: SkillSource = {
      type: "github",
      displayName: `${spec.owner}/${spec.repo}`,
      prefix: `${spec.owner}-${spec.repo}`,
      owner: spec.owner,
      repo: spec.repo,
    };
    map[cachePath] = source;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(cachePath, subdir)] = source;
    }
  }

  // Map well-known publisher cache directories. The skills root used at
  // discovery time is `<cachePath>/skills`, and each skill lives in its own
  // subdirectory. Mark the skills root so discoverSkills() picks them up.
  for (const spec of wellKnownSpecs) {
    const cachePath = getWellKnownCachePath(spec, wellKnownCacheDir);
    const skillsRoot = path.join(cachePath, "skills");
    const source: SkillSource = {
      type: "well-known",
      displayName: getWellKnownDisplayName(spec),
      prefix: getWellKnownPrefix(spec),
      origin: spec.origin,
    };
    map[skillsRoot] = source;
    map[cachePath] = source;
  }

  // Map bundled skills directory
  if (bundledDir) {
    map[bundledDir] = BUNDLED_SKILL_SOURCE;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(bundledDir, subdir)] = BUNDLED_SKILL_SOURCE;
    }
  }

  return map;
}

/**
 * Current skill directories (mutable to support UI-driven changes).
 * This includes both local directories and GitHub cache directories.
 */
let currentSkillsDirs: string[] = [];

/**
 * GitHub specs that are currently being polled.
 */
let currentGithubSpecs: GitHubRepoSpec[] = [];

/**
 * Well-known publisher specs that are currently being polled.
 */
let currentWellKnownSpecs: WellKnownSpec[] = [];

/**
 * Current directory-to-source map for skill discovery.
 * Maps directory paths to their source info (local or GitHub).
 */
let currentSourceMap: DirectorySourceMap = {};

/**
 * Check if static mode is enabled.
 * Static mode freezes the skills list at startup - no file watching,
 * no listChanged notifications for tools/prompts.
 * Priority: CLI flag > env var > config file
 */
export function getStaticMode(): boolean {
  // Check CLI flag (highest priority)
  const args = process.argv.slice(2);
  if (args.includes("--static")) {
    return true;
  }

  // Check environment variable
  const envValue = process.env.SKILLJACK_STATIC?.toLowerCase();
  if (envValue === "true" || envValue === "1" || envValue === "yes") {
    return true;
  }

  // Check config file (lowest priority)
  return getStaticModeFromConfig();
}

/**
 * Resolve which channel carries the skill catalog (see CatalogMode in
 * skill-tool.ts — exactly one channel, never both). Priority: `--catalog=<mode>`
 * (single token so it isn't parsed as a skill directory) > SKILLJACK_CATALOG
 * env var > "instructions". Unknown values warn and fall back to the default.
 */
export function getCatalogMode(): CatalogMode {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith("--catalog="));
  const raw = flag ? flag.slice("--catalog=".length) : process.env.SKILLJACK_CATALOG;
  if (!raw) {
    return "instructions";
  }
  const value = raw.toLowerCase();
  if (value === "tool-description" || value === "instructions") {
    return value;
  }
  console.error(
    `Unknown catalog mode "${raw}" (expected tool-description | instructions); using "instructions"`
  );
  return "instructions";
}

/**
 * One-time startup warning for the legacy tool-description catalog channel.
 * Called from main() (not getCatalogMode(), which runs again on refresh and
 * per HTTP request) so it prints exactly once per process.
 */
export function warnIfLegacyCatalogMode(mode: CatalogMode): void {
  if (mode !== "tool-description") {
    return;
  }
  console.error(
    "Warning: --catalog=tool-description is a legacy escape hatch and not recommended. " +
      "Clients with tool search / deferred tool loading enabled (the modern Claude Code default) keep the load-skill description — and the skill catalog inside it — out of model context, so skills won't auto-activate unless the client sets ENABLE_TOOL_SEARCH=false. " +
      "Each catalog refresh also invalidates the client's entire prompt cache, since tool definitions sit at the top of the cached prompt prefix. " +
      "Prefer the default instructions mode. See https://github.com/olaservo/skilljack-mcp/issues/78"
  );
}

/**
 * Resolve the HTTP port if HTTP transport is requested, else null (stdio).
 *
 * Enabled via `--http` / `--http=<port>` (single token so it isn't parsed as a
 * skill directory) or `SKILLJACK_HTTP_PORT` / `SKILLJACK_HTTP`. Precedence for
 * the port: `--http=<port>` > `SKILLJACK_HTTP_PORT` > default 3000.
 */
export function getHttpPort(): number | null {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a === "--http" || a.startsWith("--http="));
  const envPortRaw = process.env.SKILLJACK_HTTP_PORT;
  const envToggle = process.env.SKILLJACK_HTTP?.toLowerCase();
  const envEnabled =
    !!envPortRaw || envToggle === "true" || envToggle === "1" || envToggle === "yes";

  if (!flag && !envEnabled) {
    return null;
  }

  if (flag && flag.startsWith("--http=")) {
    const p = parseInt(flag.slice("--http=".length), 10);
    // `>= 0` so `--http=0` binds an OS-assigned (ephemeral) port; the "ready"
    // log line reports the actual port.
    if (!Number.isNaN(p) && p >= 0) return p;
  }
  const envPort = parseInt(envPortRaw ?? "", 10);
  if (!Number.isNaN(envPort) && envPort > 0) return envPort;
  return 3000;
}

/**
 * Classify paths as local directories, GitHub repositories, or well-known
 * publishers. Detection order: GitHub URL → well-known URL → local path.
 */
export function classifyPaths(paths: string[]): {
  localDirs: string[];
  githubSpecs: GitHubRepoSpec[];
  wellKnownSpecs: WellKnownSpec[];
} {
  const localDirs: string[] = [];
  const githubSpecs: GitHubRepoSpec[] = [];
  const wellKnownSpecs: WellKnownSpec[] = [];
  const wkConfig = getWellKnownConfig();

  for (const p of paths) {
    if (isGitHubUrl(p)) {
      try {
        const spec = parseGitHubUrl(p);
        githubSpecs.push(spec);
      } catch (error) {
        console.error(`Warning: Invalid GitHub URL "${p}": ${error}`);
      }
    } else if (isWellKnownUrl(p)) {
      try {
        const spec = parseWellKnownUrl(p, wkConfig.allowHttp);
        wellKnownSpecs.push(spec);
      } catch (error) {
        console.error(`Warning: Invalid well-known URL "${p}": ${error}`);
      }
    } else {
      // Local directory - resolve the path
      localDirs.push(path.resolve(p));
    }
  }

  // Deduplicate local dirs
  const uniqueLocalDirs = [...new Set(localDirs)];

  // Deduplicate GitHub specs by owner/repo
  const seenRepos = new Set<string>();
  const uniqueGithubSpecs = githubSpecs.filter((spec) => {
    const key = `${spec.owner}/${spec.repo}`;
    if (seenRepos.has(key)) {
      return false;
    }
    seenRepos.add(key);
    return true;
  });

  // Deduplicate well-known specs by origin + basePath
  const seenWk = new Set<string>();
  const uniqueWellKnownSpecs = wellKnownSpecs.filter((spec) => {
    const key = `${spec.origin}${spec.basePath}`;
    if (seenWk.has(key)) return false;
    seenWk.add(key);
    return true;
  });

  return {
    localDirs: uniqueLocalDirs,
    githubSpecs: uniqueGithubSpecs,
    wellKnownSpecs: uniqueWellKnownSpecs,
  };
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
};

/**
 * Discover skills from multiple configured directories.
 * Each directory is checked along with its standard subdirectories.
 * Handles duplicate skill names by keeping first occurrence.
 *
 * @param skillsDirs - The skill directories to scan
 * @param sourceMap - Map from directory paths to source info
 */
function discoverSkillsFromDirs(
  skillsDirs: string[],
  sourceMap: DirectorySourceMap
): ReturnType<typeof discoverSkills> {
  const allSkills: ReturnType<typeof discoverSkills> = [];
  const seenNames = new Map<string, string>(); // name -> source directory

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) {
      console.error(`Warning: Skills directory not found: ${skillsDir}`);
      continue;
    }

    console.error(`Scanning skills directory: ${skillsDir}`);

    // Get source info for this directory (default to local if not in map)
    const dirSource = sourceMap[skillsDir] || DEFAULT_SKILL_SOURCE;

    // Check if the directory itself contains skills
    const dirSkills = discoverSkills(skillsDir, dirSource);

    // Also check standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      const subPath = path.join(skillsDir, subdir);
      if (fs.existsSync(subPath)) {
        // Use subpath source if available, otherwise inherit from parent
        const subSource = sourceMap[subPath] || dirSource;
        dirSkills.push(...discoverSkills(subPath, subSource));
      }
    }

    // Add skills, checking for duplicates
    for (const skill of dirSkills) {
      if (seenNames.has(skill.name)) {
        console.error(
          `Warning: Duplicate skill "${skill.name}" found in ${path.dirname(skill.path)} ` +
            `(already loaded from ${seenNames.get(skill.name)})`
        );
        continue; // Skip duplicate
      }
      seenNames.set(skill.name, path.dirname(skill.path));
      allSkills.push(skill);
    }
  }

  return allSkills;
}

/**
 * Debounce delay for skill directory changes (ms).
 * Multiple rapid changes are coalesced into one refresh.
 */
const SKILL_REFRESH_DEBOUNCE_MS = 500;

/**
 * Refresh skills and notify clients of changes.
 * Called when skill files change on disk.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing resource subscriptions
 */
/**
 * Re-discover skills and swap skillState.skillMap — the transport-agnostic
 * core of a refresh. Used directly by the HTTP path (where each request reads
 * skillState fresh, so a state swap is all a refresh needs) and by
 * refreshSkills() on the stdio path (which adds the server-bound updates:
 * tool description, prompts, subscriptions, notifications).
 */
function refreshSkillState(skillsDirs: string[]): void {
  console.error("Refreshing skills...");

  // Re-discover all skills using current source map
  let skills = discoverSkillsFromDirs(skillsDirs, currentSourceMap);
  const oldCount = skillState.skillMap.size;

  // Apply invocation overrides from config
  const overrides = getSkillInvocationOverrides();
  skills = applyInvocationOverrides(skills, overrides);

  // Update shared state
  skillState.skillMap = createSkillMap(skills);

  console.error(`Skills refreshed: ${oldCount} -> ${skills.length} skill(s)`);
  warnLargeSkillCount(skills.length);
}

function refreshSkills(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  refreshSkillState(skillsDirs);

  // Update the skill tool description with new instructions. In
  // catalog=instructions mode this is usage-only (no skill list) — the catalog
  // lives in server instructions, which the SDK freezes at construction, so
  // dynamic skill changes cannot reach the client until restart in that mode.
  skillTool.update({
    description: getToolDescription(skillState, getCatalogMode()),
  });

  // Refresh prompts to match new skill state
  refreshPrompts(server, skillState, promptRegistry);

  // Refresh resource subscriptions to match new skill state
  refreshSubscriptions(subscriptionManager, skillState, (uri) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  });

  // Notify clients that tools have changed
  // This prompts clients to call tools/list again
  server.sendToolListChanged();

  // Also notify that resources have changed
  server.sendResourceListChanged();

  // The SEP-2640 index resource always changes when the skill list changes,
  // even when no individual SKILL.md was modified (e.g., a skill was added
  // or removed). Emit an explicit update notification so subscribed clients
  // refetch.
  server.server.notification({
    method: "notifications/resources/updated",
    params: { uri: "skill://index.json" },
  });
}

/**
 * Set up file watchers on skill directories to detect changes.
 * Watches for SKILL.md additions, modifications, and deletions.
 *
 * @param skillsDirs - The configured skill directories
 * @param onRefresh - Called (debounced) when skills change. The stdio path
 *   passes refreshSkills (state + server updates + notifications); the HTTP
 *   path passes refreshSkillState (state only — requests read it fresh).
 */
function watchSkillDirectories(
  skillsDirs: string[],
  onRefresh: () => void
): void {
  let refreshTimeout: NodeJS.Timeout | null = null;

  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      onRefresh();
    }, SKILL_REFRESH_DEBOUNCE_MS);
  };

  // Build list of paths to watch
  const watchPaths: string[] = [];
  for (const dir of skillsDirs) {
    if (fs.existsSync(dir)) {
      watchPaths.push(dir);
      // Also watch standard subdirectories
      for (const subdir of SKILL_SUBDIRS) {
        const subPath = path.join(dir, subdir);
        if (fs.existsSync(subPath)) {
          watchPaths.push(subPath);
        }
      }
    }
  }

  if (watchPaths.length === 0) {
    console.error("No skill directories to watch");
    return;
  }

  console.error(`Watching for skill changes in: ${watchPaths.join(", ")}`);

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 2, // Watch skill subdirectories but not too deep
    ignored: ["**/node_modules/**", "**/.git/**"],
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  // Watch for SKILL.md changes specifically
  watcher.on("add", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill added: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("change", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill modified: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlink", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill removed: ${filePath}`);
      debouncedRefresh();
    }
  });

  // Also watch for directory additions (new skill folders)
  watcher.on("addDir", (dirPath) => {
    // Check if this might be a new skill directory
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const skillMdPathLower = path.join(dirPath, "skill.md");
    if (fs.existsSync(skillMdPath) || fs.existsSync(skillMdPathLower)) {
      console.error(`Skill directory added: ${dirPath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlinkDir", (dirPath) => {
    // A skill directory was removed
    console.error(`Directory removed: ${dirPath}`);
    debouncedRefresh();
  });
}

/**
 * Start GitHub / well-known polling managers that re-sync remote sources and
 * invoke onRefresh when updates land. Shared by the stdio and HTTP paths —
 * only the refresh callback differs (stdio also pushes notifications).
 */
function startRemoteSourcePolling(
  githubConfig: ReturnType<typeof getGitHubConfig>,
  wellKnownConfig: ReturnType<typeof getWellKnownConfig>,
  onRefresh: () => void
): void {
  if (currentGithubSpecs.length > 0 && githubConfig.pollIntervalMs > 0) {
    const syncOptions: SyncOptions = {
      cacheDir: githubConfig.cacheDir,
      token: githubConfig.token,
      shallowClone: true,
    };

    const pollingManager = createPollingManager(currentGithubSpecs, syncOptions, {
      intervalMs: githubConfig.pollIntervalMs,
      onUpdate: (spec) => {
        console.error(`GitHub update detected for ${spec.owner}/${spec.repo}`);
        onRefresh();
      },
      onError: (spec, error) => {
        console.error(`GitHub polling error for ${spec.owner}/${spec.repo}: ${error.message}`);
      },
    });

    pollingManager.start();
  }

  if (currentWellKnownSpecs.length > 0 && wellKnownConfig.pollIntervalMs > 0) {
    const wkSyncOptions: WellKnownSyncOptions = {
      cacheDir: wellKnownConfig.cacheDir,
      maxArtifactBytes: wellKnownConfig.maxArtifactBytes,
      maxUnpackedBytes: wellKnownConfig.maxUnpackedBytes,
      allowedOrigins: wellKnownConfig.allowedOrigins,
      allowHttp: wellKnownConfig.allowHttp,
    };

    const wellKnownPollingManager = createWellKnownPollingManager(
      currentWellKnownSpecs,
      wkSyncOptions,
      {
        intervalMs: wellKnownConfig.pollIntervalMs,
        onUpdate: (spec) => {
          console.error(`Well-known update detected for ${spec.origin}`);
          onRefresh();
        },
        onError: (spec, error) => {
          console.error(`Well-known polling error for ${spec.origin}: ${error.message}`);
        },
      }
    );

    wellKnownPollingManager.start();
  }
}

/**
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  // Check if static mode is enabled
  const isStatic = getStaticMode();

  // Get skill directories from CLI args, env var, or config file
  // This returns paths that may include GitHub URLs
  const allPaths = getActiveDirectories();

  // Classify paths as local, GitHub, or well-known
  const { localDirs, githubSpecs, wellKnownSpecs } = classifyPaths(allPaths);

  // Get GitHub configuration
  const githubConfig = getGitHubConfig();

  // Get well-known configuration
  const wellKnownConfig = getWellKnownConfig();

  // Sync GitHub repositories
  let githubDirs: string[] = [];

  if (githubSpecs.length > 0) {
    console.error(`GitHub repos: ${githubSpecs.map((s) => `${s.owner}/${s.repo}`).join(", ")}`);

    // Filter by allowlist
    for (const spec of githubSpecs) {
      if (!isRepoAllowed(spec, githubConfig)) {
        console.error(
          `Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users. ` +
            `Set GITHUB_ALLOWED_ORGS or GITHUB_ALLOWED_USERS to permit.`
        );
        continue;
      }
      currentGithubSpecs.push(spec);
    }

    if (currentGithubSpecs.length > 0) {
      console.error(`Syncing ${currentGithubSpecs.length} GitHub repo(s)...`);

      const syncOptions: SyncOptions = {
        cacheDir: githubConfig.cacheDir,
        token: githubConfig.token,
        shallowClone: true,
      };

      const results = await syncAllRepos(currentGithubSpecs, syncOptions);

      // Collect successful sync paths
      for (const result of results) {
        if (!result.error) {
          githubDirs.push(result.localPath);
        }
      }

      console.error(`Successfully synced ${githubDirs.length}/${currentGithubSpecs.length} repo(s)`);
    }
  }

  // Sync well-known publishers
  let wellKnownDirs: string[] = [];

  if (wellKnownSpecs.length > 0) {
    console.error(
      `Well-known publishers: ${wellKnownSpecs.map((s) => getWellKnownDisplayName(s)).join(", ")}`
    );

    for (const spec of wellKnownSpecs) {
      if (!isOriginAllowed(spec, wellKnownConfig)) {
        console.error(
          `Blocked: ${spec.origin} not in allowed origins. ` +
            `Set WELL_KNOWN_ALLOWED_ORIGINS or wellKnownAllowedOrigins in config to permit.`
        );
        continue;
      }
      currentWellKnownSpecs.push(spec);
    }

    if (currentWellKnownSpecs.length > 0) {
      console.error(`Syncing ${currentWellKnownSpecs.length} well-known publisher(s)...`);

      const wkSyncOptions: WellKnownSyncOptions = {
        cacheDir: wellKnownConfig.cacheDir,
        maxArtifactBytes: wellKnownConfig.maxArtifactBytes,
        maxUnpackedBytes: wellKnownConfig.maxUnpackedBytes,
        allowedOrigins: wellKnownConfig.allowedOrigins,
        allowHttp: wellKnownConfig.allowHttp,
      };

      const wkResults = await syncAllWellKnown(currentWellKnownSpecs, wkSyncOptions);

      for (const result of wkResults) {
        if (!result.error) {
          wellKnownDirs.push(result.localPath);
        }
      }

      console.error(
        `Successfully synced ${wellKnownDirs.length}/${currentWellKnownSpecs.length} publisher(s)`
      );
    }
  }

  // Get bundled skills directory (ships with the package)
  const bundledSkillsDir = getBundledSkillsDir();
  const hasBundledSkills = fs.existsSync(bundledSkillsDir);

  // Combine all skill directories
  // User directories come first so they can override bundled skills (first-wins deduplication)
  currentSkillsDirs = [
    ...localDirs,
    ...githubDirs,
    ...wellKnownDirs,
    ...(hasBundledSkills ? [bundledSkillsDir] : []),
  ];

  // Build source map for skill discovery
  currentSourceMap = buildDirectorySourceMap(
    localDirs,
    currentGithubSpecs,
    githubConfig.cacheDir,
    currentWellKnownSpecs,
    wellKnownConfig.cacheDir,
    hasBundledSkills ? bundledSkillsDir : undefined
  );

  // Log configured directories
  if (localDirs.length > 0) {
    console.error(`Local directories: ${localDirs.join(", ")}`);
  }
  if (githubDirs.length > 0) {
    console.error(`GitHub cache directories: ${githubDirs.join(", ")}`);
  }
  if (wellKnownDirs.length > 0) {
    console.error(`Well-known cache directories: ${wellKnownDirs.join(", ")}`);
  }
  if (hasBundledSkills) {
    console.error(`Bundled skills: ${bundledSkillsDir}`);
  }

  if (isStatic) {
    console.error("Static mode enabled - skills list frozen at startup");
  }

  // Discover skills at startup
  let skills = discoverSkillsFromDirs(currentSkillsDirs, currentSourceMap);

  // Apply invocation overrides from config
  const overrides = getSkillInvocationOverrides();
  skills = applyInvocationOverrides(skills, overrides);

  skillState.skillMap = createSkillMap(skills);
  console.error(`Discovered ${skills.length} skill(s)`);
  warnLargeSkillCount(skills.length);

  // HTTP transport: serve the core skill surface over stateless HTTP and return.
  // Discovery-on-change works the same as stdio — file watchers and remote-source
  // polling refresh skillState, and every request (including each new client's
  // initialize, which carries the instructions catalog) reads that state fresh.
  // What stateless HTTP cannot do is *push*: no listChanged/resources/updated
  // notifications, so already-connected clients see changes on their next
  // request rather than being told to refresh. UI config/display tools remain
  // stdio-only.
  const httpPort = getHttpPort();
  const catalogMode = getCatalogMode();
  warnIfLegacyCatalogMode(catalogMode);
  if (httpPort !== null) {
    if (!isStatic) {
      if (currentSkillsDirs.length > 0) {
        watchSkillDirectories(currentSkillsDirs, () => refreshSkillState(currentSkillsDirs));
      }
      startRemoteSourcePolling(githubConfig, wellKnownConfig, () =>
        refreshSkillState(currentSkillsDirs)
      );
    }
    await startHttpServer(httpPort, skillState, catalogMode);
    return;
  }

  // Create the MCP server
  // In static mode, disable listChanged for tools/prompts (skills list is frozen)
  // Resource subscriptions remain dynamic for individual skill file watching
  //
  // The skill catalog goes through exactly ONE channel (never both): server
  // instructions (default; survives tool-search deferral, but instructions are
  // set once at construction, so the catalog is frozen until restart on stdio)
  // or the load-skill tool description (`--catalog=tool-description`; dynamic
  // via tools/listChanged, but deferred out of context under tool search).
  const initialInstructions = getServerInstructions(skillState, catalogMode);

  const server = new McpServer(
    {
      name: "skilljack-mcp",
      version: "0.13.0",
    },
    {
      capabilities: {
        tools: { listChanged: !isStatic },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: !isStatic },
        // SEP-2640 (Skills Extension): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
        extensions: {
          "io.modelcontextprotocol/skills": {},
        },
      },
      ...(initialInstructions !== undefined && { instructions: initialInstructions }),
    }
  );

  // Register tools, resources, and prompts
  const skillTool = registerSkillTool(server, skillState, catalogMode);
  registerSkillResources(server, skillState);
  const promptRegistry = registerSkillPrompts(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Register skill-config tool for UI-based directory configuration
  // Skip in static mode since skills list is frozen
  if (!isStatic) {
    registerSkillConfigTool(server, skillState, async () => {
      // Callback when directories or remote-source settings change via UI.
      // Reload directories from config and refresh skills.
      const newPaths = getActiveDirectories();
      const {
        localDirs: newLocalDirs,
        githubSpecs: newGithubSpecs,
        wellKnownSpecs: newWellKnownSpecs,
      } = classifyPaths(newPaths);

      // Get fresh configs (in case allowlists changed)
      const freshGithubConfig = getGitHubConfig();
      const freshWellKnownConfig = getWellKnownConfig();

      // Filter GitHub specs by allowlist and sync
      const allowedGithubSpecs: GitHubRepoSpec[] = [];
      for (const spec of newGithubSpecs) {
        if (isRepoAllowed(spec, freshGithubConfig)) {
          allowedGithubSpecs.push(spec);
        } else {
          console.error(`Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users.`);
        }
      }

      let newGithubDirs: string[] = [];
      if (allowedGithubSpecs.length > 0) {
        console.error(`Syncing ${allowedGithubSpecs.length} GitHub repo(s)...`);
        const syncOptions: SyncOptions = {
          cacheDir: freshGithubConfig.cacheDir,
          token: freshGithubConfig.token,
          shallowClone: true,
        };
        const results = await syncAllRepos(allowedGithubSpecs, syncOptions);
        for (const result of results) {
          if (!result.error) {
            newGithubDirs.push(result.localPath);
          }
        }
        console.error(`Successfully synced ${newGithubDirs.length}/${allowedGithubSpecs.length} repo(s)`);
      }

      // Filter well-known specs by allowlist and sync
      const allowedWellKnownSpecs: WellKnownSpec[] = [];
      for (const spec of newWellKnownSpecs) {
        if (isOriginAllowed(spec, freshWellKnownConfig)) {
          allowedWellKnownSpecs.push(spec);
        } else {
          console.error(`Blocked: ${spec.origin} not in allowed origins.`);
        }
      }

      let newWellKnownDirs: string[] = [];
      if (allowedWellKnownSpecs.length > 0) {
        console.error(`Syncing ${allowedWellKnownSpecs.length} well-known publisher(s)...`);
        const wkSyncOptions: WellKnownSyncOptions = {
          cacheDir: freshWellKnownConfig.cacheDir,
          maxArtifactBytes: freshWellKnownConfig.maxArtifactBytes,
          maxUnpackedBytes: freshWellKnownConfig.maxUnpackedBytes,
          allowedOrigins: freshWellKnownConfig.allowedOrigins,
          allowHttp: freshWellKnownConfig.allowHttp,
        };
        const wkResults = await syncAllWellKnown(allowedWellKnownSpecs, wkSyncOptions);
        for (const result of wkResults) {
          if (!result.error) {
            newWellKnownDirs.push(result.localPath);
          }
        }
        console.error(
          `Successfully synced ${newWellKnownDirs.length}/${allowedWellKnownSpecs.length} publisher(s)`
        );
      }

      // Update current state
      currentGithubSpecs = allowedGithubSpecs;
      currentWellKnownSpecs = allowedWellKnownSpecs;
      githubDirs = newGithubDirs;
      wellKnownDirs = newWellKnownDirs;
      // Include bundled skills (last, so user skills take precedence)
      currentSkillsDirs = [
        ...newLocalDirs,
        ...newGithubDirs,
        ...newWellKnownDirs,
        ...(hasBundledSkills ? [bundledSkillsDir] : []),
      ];
      currentSourceMap = buildDirectorySourceMap(
        newLocalDirs,
        allowedGithubSpecs,
        freshGithubConfig.cacheDir,
        allowedWellKnownSpecs,
        freshWellKnownConfig.cacheDir,
        hasBundledSkills ? bundledSkillsDir : undefined
      );

      console.error(`Config changed via UI. Directories: ${currentSkillsDirs.join(", ") || "(none)"}`);
      refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
    });

    // Register skill-display tool for UI-based invocation settings
    registerSkillDisplayTool(server, skillState, () => {
      // Callback when invocation settings change via UI
      // Refresh skills to apply new overrides
      console.error("Invocation settings changed via UI. Refreshing skills...");
      refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
    });
  }

  // Set up file watchers and remote-source polling (skip in static mode).
  // On stdio a refresh also updates the tool/prompts and pushes notifications.
  if (!isStatic) {
    const refreshAll = () =>
      refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
    if (currentSkillsDirs.length > 0) {
      watchSkillDirectories(currentSkillsDirs, refreshAll);
    }
    startRemoteSourcePolling(githubConfig, wellKnownConfig, refreshAll);
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skilljack ready. I know kung fu.");
}

// Only run main() when executed directly (not when imported by tests)
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith("skilljack-mcp") ||
   process.argv[1] === fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
