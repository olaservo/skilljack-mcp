/**
 * Configuration management for skill directories.
 *
 * Handles loading/saving skill directory configuration from:
 * 1. CLI args (highest priority)
 * 2. SKILLS_DIR environment variable
 * 3. Config file (~/.skilljack/config.json)
 *
 * Supports both local directories and GitHub repository URLs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isGitHubUrl, parseGitHubUrl, isRepoAllowed, getGitHubConfig } from "./github-config.js";
import {
  isWellKnownUrl,
  parseWellKnownUrl,
  isOriginAllowed,
  getWellKnownConfig,
} from "./well-known-config.js";

/**
 * Invocation settings that can be overridden per skill.
 */
export interface SkillInvocationOverrides {
  assistant?: boolean; // Override disableModelInvocation (true = model can invoke)
  user?: boolean; // Override userInvocable (true = appears in prompts menu)
}

/**
 * Configuration file schema.
 */
export interface SkillConfig {
  skillDirectories: string[];
  staticMode?: boolean;
  skillInvocationOverrides?: Record<string, SkillInvocationOverrides>;
  githubAllowedOrgs?: string[];
  githubAllowedUsers?: string[];
  wellKnownAllowedOrigins?: string[];
}

/**
 * Source of a skill directory configuration.
 */
export type DirectorySource = "cli" | "env" | "config";

/**
 * Type of skill source (local directory, GitHub repo, or well-known publisher).
 */
export type SourceType = "local" | "github" | "well-known";

/**
 * A skill directory with its source information.
 */
export interface DirectoryInfo {
  path: string;
  source: DirectorySource;
  type: SourceType;
  skillCount: number;
  valid: boolean;
  allowed: boolean; // For GitHub repos: whether org/user is in allowlist
}

/**
 * Check if a path is valid (exists for local, always valid for remote sources).
 */
function isValidPath(p: string): boolean {
  if (isGitHubUrl(p)) {
    return true; // GitHub URLs are validated during sync
  }
  if (isWellKnownUrl(p)) {
    return true; // Well-known URLs are validated during sync
  }
  return fs.existsSync(p);
}

/**
 * Get the source type for a path.
 */
function getSourceType(p: string): SourceType {
  if (isGitHubUrl(p)) return "github";
  if (isWellKnownUrl(p)) return "well-known";
  return "local";
}

/**
 * Check if a path is allowed.
 *   - Local paths: always allowed.
 *   - GitHub URLs: org/user must be in the GitHub allowlist.
 *   - Well-known URLs: origin must be in the well-known allowlist.
 */
function isPathAllowed(p: string): boolean {
  if (isGitHubUrl(p)) {
    try {
      const spec = parseGitHubUrl(p);
      const config = getGitHubConfig();
      return isRepoAllowed(spec, config);
    } catch {
      return false;
    }
  }
  if (isWellKnownUrl(p)) {
    try {
      const config = getWellKnownConfig();
      const spec = parseWellKnownUrl(p, config.allowHttp);
      return isOriginAllowed(spec, config);
    } catch {
      return false;
    }
  }
  return true; // Local paths
}

/**
 * True iff `p` is a remote URL (GitHub or well-known) that should be passed
 * through unchanged rather than resolved as a local path.
 */
function isRemoteUrl(p: string): boolean {
  return isGitHubUrl(p) || isWellKnownUrl(p);
}

/**
 * Configuration state tracking active directories and their sources.
 */
export interface ConfigState {
  /** All active directories with source info */
  directories: DirectoryInfo[];
  /** Which source is currently providing directories (cli > env > config) */
  activeSource: DirectorySource;
  /** Whether directories are overridden by CLI or env (config file edits won't take effect) */
  isOverridden: boolean;
}

/**
 * Separator for multiple paths in SKILLS_DIR environment variable.
 */
const PATH_LIST_SEPARATOR = ",";

/**
 * Get the platform-appropriate config directory path.
 * Returns ~/.skilljack on Unix, %USERPROFILE%\.skilljack on Windows.
 */
export function getConfigDir(): string {
  return path.join(os.homedir(), ".skilljack");
}

/**
 * Get the full path to the config file.
 */
export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/**
 * Ensure the config directory exists.
 */
function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Load config from the config file.
 * Returns empty config if file doesn't exist.
 */
export function loadConfigFile(): SkillConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { skillDirectories: [], skillInvocationOverrides: {} };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);

    // Validate and normalize directories (handle both local paths and GitHub URLs)
    const skillDirectories = Array.isArray(parsed.skillDirectories)
      ? parsed.skillDirectories
          .filter((p: unknown) => typeof p === "string")
          .map((p: string) => isRemoteUrl(p) ? p : path.resolve(p))
      : [];

    // Validate and normalize invocation overrides
    const skillInvocationOverrides: Record<string, SkillInvocationOverrides> = {};
    if (parsed.skillInvocationOverrides && typeof parsed.skillInvocationOverrides === "object") {
      for (const [name, override] of Object.entries(parsed.skillInvocationOverrides)) {
        if (typeof override === "object" && override !== null) {
          const validOverride: SkillInvocationOverrides = {};
          const o = override as Record<string, unknown>;
          if (typeof o.assistant === "boolean") validOverride.assistant = o.assistant;
          if (typeof o.user === "boolean") validOverride.user = o.user;
          if (Object.keys(validOverride).length > 0) {
            skillInvocationOverrides[name] = validOverride;
          }
        }
      }
    }

    return {
      skillDirectories,
      skillInvocationOverrides,
      staticMode: parsed.staticMode === true,
      githubAllowedOrgs: Array.isArray(parsed.githubAllowedOrgs) ? parsed.githubAllowedOrgs : [],
      githubAllowedUsers: Array.isArray(parsed.githubAllowedUsers) ? parsed.githubAllowedUsers : [],
      wellKnownAllowedOrigins: Array.isArray(parsed.wellKnownAllowedOrigins)
        ? parsed.wellKnownAllowedOrigins.filter((o: unknown): o is string => typeof o === "string")
        : [],
    };
  } catch (error) {
    console.error(`Warning: Failed to parse config file: ${error}`);
    return { skillDirectories: [], skillInvocationOverrides: {} };
  }
}

/**
 * Save config to the config file.
 */
export function saveConfigFile(config: SkillConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    throw new Error(`Failed to save config file: ${error}`);
  }
}

/**
 * Parse CLI arguments for skill directories.
 * Returns resolved absolute paths for local dirs, unchanged for GitHub URLs.
 */
export function parseCLIArgs(): string[] {
  const dirs: string[] = [];
  const args = process.argv.slice(2);

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      const paths = arg
        .split(PATH_LIST_SEPARATOR)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => isRemoteUrl(p) ? p : path.resolve(p));
      dirs.push(...paths);
    }
  }

  return [...new Set(dirs)]; // Deduplicate
}

/**
 * Parse SKILLS_DIR environment variable.
 * Returns resolved absolute paths for local dirs, unchanged for GitHub URLs.
 */
export function parseEnvVar(): string[] {
  const envDir = process.env.SKILLS_DIR;
  if (!envDir) {
    return [];
  }

  const dirs = envDir
    .split(PATH_LIST_SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => isRemoteUrl(p) ? p : path.resolve(p));

  return [...new Set(dirs)]; // Deduplicate
}

/**
 * Get all skill directories with their source information.
 * Priority: CLI args > env var > config file
 */
export function getConfigState(): ConfigState {
  // Check CLI args first
  const cliDirs = parseCLIArgs();
  if (cliDirs.length > 0) {
    return {
      directories: cliDirs.map((p) => ({
        path: p,
        source: "cli" as DirectorySource,
        type: getSourceType(p),
        skillCount: 0, // Will be filled in by caller
        valid: isValidPath(p),
        allowed: isPathAllowed(p),
      })),
      activeSource: "cli",
      isOverridden: true,
    };
  }

  // Check env var next
  const envDirs = parseEnvVar();
  if (envDirs.length > 0) {
    return {
      directories: envDirs.map((p) => ({
        path: p,
        source: "env" as DirectorySource,
        type: getSourceType(p),
        skillCount: 0,
        valid: isValidPath(p),
        allowed: isPathAllowed(p),
      })),
      activeSource: "env",
      isOverridden: true,
    };
  }

  // Fall back to config file
  const config = loadConfigFile();
  return {
    directories: config.skillDirectories.map((p) => ({
      path: p,
      source: "config" as DirectorySource,
      type: getSourceType(p),
      skillCount: 0,
      valid: isValidPath(p),
      allowed: isPathAllowed(p),
    })),
    activeSource: "config",
    isOverridden: false,
  };
}

/**
 * Get skill directories from all sources combined.
 * Used for the UI to show all configured directories.
 */
export function getAllDirectoriesWithSources(): DirectoryInfo[] {
  const all: DirectoryInfo[] = [];
  const seen = new Set<string>();

  // CLI dirs
  for (const p of parseCLIArgs()) {
    if (!seen.has(p)) {
      seen.add(p);
      all.push({
        path: p,
        source: "cli",
        type: getSourceType(p),
        skillCount: 0,
        valid: isValidPath(p),
        allowed: isPathAllowed(p),
      });
    }
  }

  // Env dirs
  for (const p of parseEnvVar()) {
    if (!seen.has(p)) {
      seen.add(p);
      all.push({
        path: p,
        source: "env",
        type: getSourceType(p),
        skillCount: 0,
        valid: isValidPath(p),
        allowed: isPathAllowed(p),
      });
    }
  }

  // Config file dirs
  const config = loadConfigFile();
  for (const p of config.skillDirectories) {
    if (!seen.has(p)) {
      seen.add(p);
      all.push({
        path: p,
        source: "config",
        type: getSourceType(p),
        skillCount: 0,
        valid: isValidPath(p),
        allowed: isPathAllowed(p),
      });
    }
  }

  return all;
}

/**
 * Add a directory or GitHub URL to the config file.
 * Does not affect CLI or env var configurations.
 */
export function addDirectoryToConfig(directory: string): void {
  // For remote URLs, store as-is; for local paths, resolve to absolute
  const normalized = isRemoteUrl(directory) ? directory : path.resolve(directory);

  // Validate local directories exist
  if (!isRemoteUrl(directory)) {
    if (!fs.existsSync(normalized)) {
      throw new Error(`Directory does not exist: ${normalized}`);
    }

    if (!fs.statSync(normalized).isDirectory()) {
      throw new Error(`Path is not a directory: ${normalized}`);
    }
  }

  const config = loadConfigFile();

  // Check for duplicate
  if (config.skillDirectories.includes(normalized)) {
    throw new Error(`Already configured: ${normalized}`);
  }

  config.skillDirectories.push(normalized);
  saveConfigFile(config);
}

/**
 * Remove a directory or GitHub URL from the config file.
 * Only removes from config file, not CLI or env var.
 */
export function removeDirectoryFromConfig(directory: string): void {
  // For remote URLs, use as-is; for local paths, resolve to absolute
  const normalized = isRemoteUrl(directory) ? directory : path.resolve(directory);
  const config = loadConfigFile();

  const index = config.skillDirectories.indexOf(normalized);
  if (index === -1) {
    throw new Error(`Not found in config: ${normalized}`);
  }

  config.skillDirectories.splice(index, 1);
  saveConfigFile(config);
}

/**
 * Get only the active skill directories (respecting priority).
 * This is what the server should use for skill discovery.
 */
export function getActiveDirectories(): string[] {
  const state = getConfigState();
  return state.directories.map((d) => d.path);
}

/**
 * Get static mode setting from config file.
 */
export function getStaticModeFromConfig(): boolean {
  const config = loadConfigFile();
  return config.staticMode === true;
}

/**
 * Set static mode setting in config file.
 */
export function setStaticModeInConfig(enabled: boolean): void {
  const config = loadConfigFile();
  config.staticMode = enabled;
  saveConfigFile(config);
}

/**
 * Get all skill invocation overrides from the config file.
 */
export function getSkillInvocationOverrides(): Record<string, SkillInvocationOverrides> {
  const config = loadConfigFile();
  return config.skillInvocationOverrides || {};
}

/**
 * Set an invocation override for a skill.
 * @param skillName - The name of the skill
 * @param setting - Which setting to override ("assistant" or "user")
 * @param value - The new value for the setting
 */
export function setSkillInvocationOverride(
  skillName: string,
  setting: "assistant" | "user",
  value: boolean
): void {
  const config = loadConfigFile();
  if (!config.skillInvocationOverrides) {
    config.skillInvocationOverrides = {};
  }
  if (!config.skillInvocationOverrides[skillName]) {
    config.skillInvocationOverrides[skillName] = {};
  }
  config.skillInvocationOverrides[skillName][setting] = value;
  saveConfigFile(config);
}

/**
 * Clear an invocation override for a skill (revert to frontmatter default).
 * @param skillName - The name of the skill
 * @param setting - Which setting to clear (omit to clear both)
 */
export function clearSkillInvocationOverride(
  skillName: string,
  setting?: "assistant" | "user"
): void {
  const config = loadConfigFile();
  if (!config.skillInvocationOverrides || !config.skillInvocationOverrides[skillName]) {
    return; // Nothing to clear
  }

  if (setting) {
    delete config.skillInvocationOverrides[skillName][setting];
    // Clean up empty override objects
    if (Object.keys(config.skillInvocationOverrides[skillName]).length === 0) {
      delete config.skillInvocationOverrides[skillName];
    }
  } else {
    delete config.skillInvocationOverrides[skillName];
  }

  saveConfigFile(config);
}

/**
 * Get the GitHub allowed orgs from config file.
 */
export function getGitHubAllowedOrgs(): string[] {
  const config = loadConfigFile();
  return config.githubAllowedOrgs || [];
}

/**
 * Get the GitHub allowed users from config file.
 */
export function getGitHubAllowedUsers(): string[] {
  const config = loadConfigFile();
  return config.githubAllowedUsers || [];
}

/**
 * Add a GitHub org to the allowed list.
 * @param org - The org name to allow
 */
export function addGitHubAllowedOrg(org: string): void {
  const config = loadConfigFile();
  if (!config.githubAllowedOrgs) {
    config.githubAllowedOrgs = [];
  }
  const normalized = org.toLowerCase().trim();
  if (!config.githubAllowedOrgs.some((o) => o.toLowerCase() === normalized)) {
    config.githubAllowedOrgs.push(org.trim());
    saveConfigFile(config);
  }
}

/**
 * Remove a GitHub org from the allowed list.
 * @param org - The org name to remove
 */
export function removeGitHubAllowedOrg(org: string): void {
  const config = loadConfigFile();
  if (!config.githubAllowedOrgs) {
    return;
  }
  const normalized = org.toLowerCase().trim();
  config.githubAllowedOrgs = config.githubAllowedOrgs.filter(
    (o) => o.toLowerCase() !== normalized
  );
  saveConfigFile(config);
}

/**
 * Add a GitHub user to the allowed list.
 * @param user - The user name to allow
 */
export function addGitHubAllowedUser(user: string): void {
  const config = loadConfigFile();
  if (!config.githubAllowedUsers) {
    config.githubAllowedUsers = [];
  }
  const normalized = user.toLowerCase().trim();
  if (!config.githubAllowedUsers.some((u) => u.toLowerCase() === normalized)) {
    config.githubAllowedUsers.push(user.trim());
    saveConfigFile(config);
  }
}

/**
 * Remove a GitHub user from the allowed list.
 * @param user - The user name to remove
 */
export function removeGitHubAllowedUser(user: string): void {
  const config = loadConfigFile();
  if (!config.githubAllowedUsers) {
    return;
  }
  const normalized = user.toLowerCase().trim();
  config.githubAllowedUsers = config.githubAllowedUsers.filter(
    (u) => u.toLowerCase() !== normalized
  );
  saveConfigFile(config);
}

/**
 * Get the well-known allowed origins from the config file.
 */
export function getWellKnownAllowedOrigins(): string[] {
  const config = loadConfigFile();
  return config.wellKnownAllowedOrigins || [];
}

/**
 * Add a well-known origin to the allowed list.
 * @param origin - Origin string like "https://example.com"
 */
export function addWellKnownAllowedOrigin(origin: string): void {
  const config = loadConfigFile();
  if (!config.wellKnownAllowedOrigins) {
    config.wellKnownAllowedOrigins = [];
  }
  const normalized = origin.toLowerCase().trim();
  if (!config.wellKnownAllowedOrigins.some((o) => o.toLowerCase() === normalized)) {
    config.wellKnownAllowedOrigins.push(origin.trim());
    saveConfigFile(config);
  }
}

/**
 * Remove a well-known origin from the allowed list.
 * @param origin - Origin string like "https://example.com"
 */
export function removeWellKnownAllowedOrigin(origin: string): void {
  const config = loadConfigFile();
  if (!config.wellKnownAllowedOrigins) {
    return;
  }
  const normalized = origin.toLowerCase().trim();
  config.wellKnownAllowedOrigins = config.wellKnownAllowedOrigins.filter(
    (o) => o.toLowerCase() !== normalized
  );
  saveConfigFile(config);
}
