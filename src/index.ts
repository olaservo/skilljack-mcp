#!/usr/bin/env node
/**
 * Skilljack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skilljack-mcp /path/to/skills [/path2 ...]           # Local directories
 *   skilljack-mcp --static /path/to/skills               # Static mode (no file watching)
 *   skilljack-mcp github.com/owner/repo                  # GitHub repository
 *   skilljack-mcp /local github.com/owner/repo           # Mixed local + GitHub
 *   SKILLS_DIR=/path,github.com/owner/repo skilljack-mcp # Via environment
 *   SKILLJACK_STATIC=true skilljack-mcp                  # Static mode via env
 *   (or configure local directories via the skill-config UI)
 *
 * Options:
 *   --static  Freeze skills list at startup. Disables file watching and
 *             tools/prompts listChanged notifications. Resource subscriptions
 *             remain fully dynamic.
 */

import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import chokidar from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, createSkillMap, applyInvocationOverrides, SkillSource, DEFAULT_SKILL_SOURCE, BUNDLED_SKILL_SOURCE, warnLargeSkillCount } from "./skill-discovery.js";
import { registerSkillTool, getToolDescription, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts, refreshPrompts, PromptRegistry } from "./skill-prompts.js";
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
import { createPollingManager, PollingManager } from "./github-polling.js";

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
 * @param bundledDir - Optional bundled skills directory
 */
function buildDirectorySourceMap(
  localDirs: string[],
  githubSpecs: GitHubRepoSpec[],
  cacheDir: string,
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
 * Classify paths as local directories or GitHub repositories.
 * GitHub URLs are detected by checking for "github.com" in the path.
 */
export function classifyPaths(paths: string[]): {
  localDirs: string[];
  githubSpecs: GitHubRepoSpec[];
} {
  const localDirs: string[] = [];
  const githubSpecs: GitHubRepoSpec[] = [];

  for (const p of paths) {
    if (isGitHubUrl(p)) {
      try {
        const spec = parseGitHubUrl(p);
        githubSpecs.push(spec);
      } catch (error) {
        console.error(`Warning: Invalid GitHub URL "${p}": ${error}`);
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

  return { localDirs: uniqueLocalDirs, githubSpecs: uniqueGithubSpecs };
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
function refreshSkills(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
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

  // Update the skill tool description with new instructions
  skillTool.update({
    description: getToolDescription(skillState),
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
}

/**
 * Set up file watchers on skill directories to detect changes.
 * Watches for SKILL.md additions, modifications, and deletions.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing subscriptions
 */
function watchSkillDirectories(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  let refreshTimeout: NodeJS.Timeout | null = null;

  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      refreshSkills(skillsDirs, server, skillTool, promptRegistry, subscriptionManager);
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
 * Subscription manager for resource file watching.
 */
const subscriptionManager = createSubscriptionManager();

async function main() {
  // Check if static mode is enabled
  const isStatic = getStaticMode();

  // Get skill directories from CLI args, env var, or config file
  // This returns paths that may include GitHub URLs
  const allPaths = getActiveDirectories();

  // Classify paths as local or GitHub
  const { localDirs, githubSpecs } = classifyPaths(allPaths);

  // Get GitHub configuration
  const githubConfig = getGitHubConfig();

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

  // Get bundled skills directory (ships with the package)
  const bundledSkillsDir = getBundledSkillsDir();
  const hasBundledSkills = fs.existsSync(bundledSkillsDir);

  // Combine all skill directories
  // User directories come first so they can override bundled skills (first-wins deduplication)
  currentSkillsDirs = [...localDirs, ...githubDirs, ...(hasBundledSkills ? [bundledSkillsDir] : [])];

  // Build source map for skill discovery
  currentSourceMap = buildDirectorySourceMap(
    localDirs,
    currentGithubSpecs,
    githubConfig.cacheDir,
    hasBundledSkills ? bundledSkillsDir : undefined
  );

  // Log configured directories
  if (localDirs.length > 0) {
    console.error(`Local directories: ${localDirs.join(", ")}`);
  }
  if (githubDirs.length > 0) {
    console.error(`GitHub cache directories: ${githubDirs.join(", ")}`);
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

  // Create the MCP server
  // In static mode, disable listChanged for tools/prompts (skills list is frozen)
  // Resource subscriptions remain dynamic for individual skill file watching
  const server = new McpServer(
    {
      name: "skilljack-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: { listChanged: !isStatic },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: !isStatic },
      },
    }
  );

  // Register tools, resources, and prompts
  const skillTool = registerSkillTool(server, skillState);
  registerSkillResources(server, skillState);
  const promptRegistry = registerSkillPrompts(server, skillState);

  // Register subscription handlers for resource file watching
  registerSubscriptionHandlers(server, skillState, subscriptionManager);

  // Register skill-config tool for UI-based directory configuration
  // Skip in static mode since skills list is frozen
  if (!isStatic) {
    registerSkillConfigTool(server, skillState, async () => {
      // Callback when directories or GitHub settings change via UI
      // Reload directories from config and refresh skills
      const newPaths = getActiveDirectories();
      const { localDirs: newLocalDirs, githubSpecs: newGithubSpecs } = classifyPaths(newPaths);

      // Get fresh GitHub config (in case allowed orgs/users changed)
      const freshGithubConfig = getGitHubConfig();

      // Filter GitHub specs by allowlist and sync
      const allowedGithubSpecs: GitHubRepoSpec[] = [];
      for (const spec of newGithubSpecs) {
        if (isRepoAllowed(spec, freshGithubConfig)) {
          allowedGithubSpecs.push(spec);
        } else {
          console.error(`Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users.`);
        }
      }

      // Sync any GitHub repos
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

      // Update current state
      currentGithubSpecs = allowedGithubSpecs;
      githubDirs = newGithubDirs;
      // Include bundled skills (last, so user skills take precedence)
      currentSkillsDirs = [...newLocalDirs, ...newGithubDirs, ...(hasBundledSkills ? [bundledSkillsDir] : [])];
      currentSourceMap = buildDirectorySourceMap(
        newLocalDirs,
        allowedGithubSpecs,
        freshGithubConfig.cacheDir,
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

  // Set up file watchers for skill directory changes (skip in static mode)
  if (!isStatic && currentSkillsDirs.length > 0) {
    watchSkillDirectories(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
  }

  // Set up GitHub polling for updates (skip in static mode)
  let pollingManager: PollingManager | null = null;
  if (!isStatic && currentGithubSpecs.length > 0 && githubConfig.pollIntervalMs > 0) {
    const syncOptions: SyncOptions = {
      cacheDir: githubConfig.cacheDir,
      token: githubConfig.token,
      shallowClone: true,
    };

    pollingManager = createPollingManager(currentGithubSpecs, syncOptions, {
      intervalMs: githubConfig.pollIntervalMs,
      onUpdate: (spec, result) => {
        console.error(`GitHub update detected for ${spec.owner}/${spec.repo}`);
        refreshSkills(currentSkillsDirs, server, skillTool, promptRegistry, subscriptionManager);
      },
      onError: (spec, error) => {
        console.error(`GitHub polling error for ${spec.owner}/${spec.repo}: ${error.message}`);
      },
    });

    pollingManager.start();
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
