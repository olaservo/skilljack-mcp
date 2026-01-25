/**
 * Configuration management for skill directories.
 *
 * Handles loading/saving skill directory configuration from:
 * 1. CLI args (highest priority)
 * 2. SKILLS_DIR environment variable
 * 3. Config file (~/.skilljack/config.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Configuration file schema.
 */
export interface SkillConfig {
  skillDirectories: string[];
}

/**
 * Source of a skill directory configuration.
 */
export type DirectorySource = "cli" | "env" | "config";

/**
 * A skill directory with its source information.
 */
export interface DirectoryInfo {
  path: string;
  source: DirectorySource;
  skillCount: number;
  valid: boolean;
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
    return { skillDirectories: [] };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);

    // Validate and normalize
    if (!parsed.skillDirectories || !Array.isArray(parsed.skillDirectories)) {
      return { skillDirectories: [] };
    }

    return {
      skillDirectories: parsed.skillDirectories
        .filter((p: unknown) => typeof p === "string")
        .map((p: string) => path.resolve(p)),
    };
  } catch (error) {
    console.error(`Warning: Failed to parse config file: ${error}`);
    return { skillDirectories: [] };
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
 * Returns resolved absolute paths.
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
        .map((p) => path.resolve(p));
      dirs.push(...paths);
    }
  }

  return [...new Set(dirs)]; // Deduplicate
}

/**
 * Parse SKILLS_DIR environment variable.
 * Returns resolved absolute paths.
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
    .map((p) => path.resolve(p));

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
        skillCount: 0, // Will be filled in by caller
        valid: fs.existsSync(p),
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
        skillCount: 0,
        valid: fs.existsSync(p),
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
      skillCount: 0,
      valid: fs.existsSync(p),
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
        skillCount: 0,
        valid: fs.existsSync(p),
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
        skillCount: 0,
        valid: fs.existsSync(p),
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
        skillCount: 0,
        valid: fs.existsSync(p),
      });
    }
  }

  return all;
}

/**
 * Add a directory to the config file.
 * Does not affect CLI or env var configurations.
 */
export function addDirectoryToConfig(directory: string): void {
  const resolved = path.resolve(directory);

  // Validate directory exists
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  const config = loadConfigFile();

  // Check for duplicate
  if (config.skillDirectories.includes(resolved)) {
    throw new Error(`Directory already configured: ${resolved}`);
  }

  config.skillDirectories.push(resolved);
  saveConfigFile(config);
}

/**
 * Remove a directory from the config file.
 * Only removes from config file, not CLI or env var.
 */
export function removeDirectoryFromConfig(directory: string): void {
  const resolved = path.resolve(directory);
  const config = loadConfigFile();

  const index = config.skillDirectories.indexOf(resolved);
  if (index === -1) {
    throw new Error(`Directory not found in config: ${resolved}`);
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
