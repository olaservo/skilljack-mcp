// Options builder for skill evals
import * as path from "path";
import * as fs from "fs/promises";
import { spawn, ChildProcess } from "child_process";

export type EvalMode = "mcp" | "local" | "cli-local" | "mcp+local";

/**
 * Which channel the skilljack server under test uses for the skill catalog
 * (passed through as `--catalog=<mode>`; see CatalogMode in src/skill-tool.ts).
 */
export type CatalogMode = "tool-description" | "instructions";

/** Whether the Agent SDK client runs with tool search (deferred tool loading). */
export type ToolSearchSetting = "on" | "off";

/**
 * skilljack HTTP servers spawned for MCP-mode evals. Tracked so eval.ts can
 * tear them down after each run via cleanupEvalServers().
 */
const spawnedHttpServers: ChildProcess[] = [];

/**
 * Start skilljack over stateless HTTP on an ephemeral port and resolve its
 * `POST /mcp` URL once it is ready.
 *
 * MCP-mode evals use HTTP (not stdio) so the server is `connected` on the
 * model's first turn — the agent-sdk 0.3.x stdio connect race leaves a
 * stdio server `pending` and its tools absent turn 1. See evals/README.md.
 */
async function startSkilljackHttp(skillsDir: string, extraArgs: string[] = []): Promise<string> {
  const serverPath = path.resolve("./dist/index.js");
  try {
    await fs.access(serverPath);
  } catch {
    throw new Error(`Skilljack MCP server not found at ${serverPath}. Run 'npm run build' first.`);
  }
  const absoluteSkillsDir = path.resolve(skillsDir);
  const proc = spawn("node", [serverPath, "--http=0", ...extraArgs, absoluteSkillsDir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  spawnedHttpServers.push(proc);

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("skilljack HTTP start timeout")), 15000);
    let buf = "";
    proc.stderr!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/http:\/\/localhost:(\d+)\/mcp/);
      if (m) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${m[1]}/mcp`);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`skilljack HTTP server exited early (code ${code})`));
    });
  });
}

/** Kill any skilljack HTTP servers spawned for evals. Call in eval.ts finally. */
export function cleanupEvalServers(): void {
  for (const proc of spawnedHttpServers) {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }
  spawnedHttpServers.length = 0;
}

/**
 * ENABLE_TOOL_SEARCH=false loads all tool definitions (incl. skilljack's
 * load-skill tool description, which carries the <available_skills> catalog)
 * into context every turn. With tool search ON (default), MCP tool descriptions
 * are DEFERRED out of context, so the model never sees the skill catalog and
 * won't activate. Skilljack's catalog-in-tool-description method requires this
 * to be off; the catalog-in-instructions method (--catalog=instructions) is the
 * experiment for surviving tool search ON. See evals/README.md.
 *
 * Always set explicitly (both "true" and "false") so a stray value in the
 * parent shell environment can't skew runs.
 */
function toolSearchEnv(toolSearch: ToolSearchSetting): { ENABLE_TOOL_SEARCH: string } {
  return { ENABLE_TOOL_SEARCH: toolSearch === "on" ? "true" : "false" };
}

export interface BuildOptionsConfig {
  mode: EvalMode;
  systemPrompt?: string;  // Optional - uses Claude Code default if not provided
  model?: string;
  skillsDir: string;  // Path to test skills directory
  catalog?: CatalogMode;  // Skilljack --catalog mode (MCP modes; server default "instructions" if unset)
  toolSearch?: ToolSearchSetting;  // Agent SDK tool search (default "off" = pre-existing behavior)
}

/**
 * Copy skills to .claude/skills/ for local mode
 */
export async function setupLocalSkills(skillsDir: string): Promise<void> {
  const sourceDir = path.resolve(skillsDir);
  const targetDir = path.resolve('.claude/skills');

  // Create target directory
  await fs.mkdir(targetDir, { recursive: true });

  // Get all skill directories
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sourceSkillDir = path.join(sourceDir, entry.name);
      const targetSkillDir = path.join(targetDir, entry.name);

      // Copy skill directory recursively
      await copyDir(sourceSkillDir, targetSkillDir);
    }
  }

  console.log(`Copied skills to ${targetDir}`);
}

/**
 * Ensure .claude/settings.json exists for local skill discovery
 */
async function ensureSettingsJson(): Promise<void> {
  const settingsPath = path.resolve('.claude/settings.json');

  try {
    await fs.access(settingsPath);
    // Settings file exists
  } catch {
    // Create minimal settings file
    const settings = {
      permissions: {
        allow: [],
        deny: []
      }
    };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`Created ${settingsPath}`);
  }
}

/**
 * Clean up .claude/skills/ after local mode
 */
export async function cleanupLocalSkills(): Promise<void> {
  const targetDir = path.resolve('.claude/skills');

  try {
    await fs.rm(targetDir, { recursive: true });
    console.log(`Cleaned up ${targetDir}`);
  } catch {
    // Directory may not exist
  }
}

/**
 * Recursively copy a directory
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Build query options for skill eval
 */
export async function buildOptions(config: BuildOptionsConfig): Promise<any> {
  const { mode, systemPrompt, model, skillsDir, catalog, toolSearch = "off" } = config;
  const skilljackArgs = catalog ? [`--catalog=${catalog}`] : [];

  // Default to Sonnet 4.6
  const modelId = model || "claude-sonnet-4-6";

  // Skill context is NOT injected into the client systemPrompt — it already
  // arrives via the skilljack MCP server's tool descriptions (getToolDescription
  // in src/skill-tool.ts) or Claude Code's local Skill tool description. Adding
  // it here would be duplicative and leak <location> paths that tempt the model
  // to Read the file directly instead of going through the skill tool.
  //
  // A minimal string prompt is used for all modes (not the `claude_code`
  // preset).
  //
  // MCP-mode activation on agent-sdk 0.3.x required working around TWO
  // independent regressions (verified 2026-07-05 by controlled experiments):
  //   A) stdio connect race — the SDK connects stdio MCP servers asynchronously,
  //      so a stdio skilljack is still `pending` at init and its tools are absent
  //      on the model's first turn (upstream anthropics/claude-code#49753).
  //      → Fixed here by running skilljack over HTTP (startSkilljackHttp), which
  //        is `connected` on turn 1.
  //   B) tool search / deferred tools — MCP tool DESCRIPTIONS are deferred out of
  //      context, so the model never sees skilljack's <available_skills> catalog
  //      (which lives in the load-skill tool description) and won't activate.
  //      → Fixed here by ENABLE_TOOL_SEARCH=false (TOOL_SEARCH_OFF_ENV).
  // Both are needed together for clean activation. It is NOT the system prompt,
  // NOT the claude_code preset, and NOT allowedTools.
  const MINIMAL_SYSTEM_PROMPT =
    "You are a helpful assistant. Use the tools available to you to complete the user's request.";
  const effectiveSystemPrompt = systemPrompt
    ? `${MINIMAL_SYSTEM_PROMPT}\n\n${systemPrompt}`
    : MINIMAL_SYSTEM_PROMPT;

  let options: Record<string, unknown>;

  if (mode === "cli-local") {
    // CLI Local mode: set up skills in .claude/skills/ for CLI to discover
    await setupLocalSkills(skillsDir);
    await ensureSettingsJson();

    // Return minimal options - CLI will use its own defaults
    options = {
      cwd: process.cwd(),
      model: modelId
    };
  } else if (mode === "local") {
    // Local mode: use settingSources and the native Skill tool. A minimal
    // string prompt is used (not the claude_code preset). Unlike MCP mode, the
    // native Skill tool is present on the model's first turn, so activation
    // works here — see the async-MCP-connect note above.
    await setupLocalSkills(skillsDir);
    await ensureSettingsJson();

    options = {
      cwd: process.cwd(),
      systemPrompt: effectiveSystemPrompt,
      settingSources: ['project' as const],
      allowedTools: ["Bash", "Read", "Write", "Skill"],
      permissionMode: "default" as const,
      model: modelId,
      // Uniform tool visibility across modes (the native Skill tool can also be
      // deferred under tool search); keeps cross-mode comparisons apples-to-apples.
      env: { ...process.env, ...toolSearchEnv(toolSearch) }
    };
  } else if (mode === "mcp+local") {
    // Combined mode: both MCP server (over HTTP) AND local skills enabled.
    // Tests which delivery the agent prefers when both are available.
    await setupLocalSkills(skillsDir);
    await ensureSettingsJson();

    const url = await startSkilljackHttp(skillsDir, skilljackArgs);

    options = {
      cwd: process.cwd(),
      mcpServers: {
        skilljack: { type: "http" as const, url }
      },
      systemPrompt: effectiveSystemPrompt,
      settingSources: ['project' as const],
      // Allow both MCP and local skill tools
      allowedTools: ["Bash", "Read", "Write", "Skill", "mcp__skilljack"],
      permissionMode: "default" as const,
      model: modelId,
      env: { ...process.env, ...toolSearchEnv(toolSearch) }
    };
  } else {
    // MCP mode: skilljack over HTTP (avoids the stdio connect race, regression A)
    // + tool search off by default (surfaces the tool-description catalog,
    // regression B). --tool-search=on + --catalog=instructions is the
    // instructions-channel experiment.
    const url = await startSkilljackHttp(skillsDir, skilljackArgs);

    options = {
      cwd: process.cwd(),
      mcpServers: {
        skilljack: { type: "http" as const, url }
      },
      systemPrompt: effectiveSystemPrompt,
      allowedTools: ["mcp__skilljack"],
      permissionMode: "default" as const,
      model: modelId,
      env: { ...process.env, ...toolSearchEnv(toolSearch) }
    };
  }

  return options;
}
