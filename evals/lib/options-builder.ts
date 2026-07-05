// Options builder for skill evals
import * as path from "path";
import * as fs from "fs/promises";

export type EvalMode = "mcp" | "local" | "cli-local" | "mcp+local";

export interface BuildOptionsConfig {
  mode: EvalMode;
  systemPrompt?: string;  // Optional - uses Claude Code default if not provided
  model?: string;
  skillsDir: string;  // Path to test skills directory
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
  const { mode, systemPrompt, model, skillsDir } = config;

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
  // KNOWN ISSUE — MCP-mode activation on agent-sdk 0.3.x:
  // In MCP mode the model frequently fails to call the skilljack skill tool.
  // Root cause (verified 2026-07-05 via an init-message probe + a controlled
  // 2x2): agent-sdk 0.3.x connects stdio MCP servers *asynchronously*, so the
  // skilljack server is still `pending` at the SDK init message and its tools
  // are absent from the tool list the model sees on its first turn — the model
  // answers directly before skilljack finishes connecting. On 0.1.x the server
  // connected synchronously before the first turn and activation worked.
  // It is NOT the system prompt, NOT the `claude_code` preset (forcing the
  // preset on 0.3.x still fails to activate), and NOT allowedTools. Local/native
  // mode is unaffected because the native Skill tool is present on turn 1.
  // Fix options: pin evals to a 0.1.x SDK, wait for MCP connection before the
  // first query if the SDK exposes a hook, or fix upstream.
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
      model: modelId
    };
  } else if (mode === "mcp+local") {
    // Combined mode: both MCP server AND local skills enabled
    // Tests behavior when both skill delivery mechanisms are available
    await setupLocalSkills(skillsDir);
    await ensureSettingsJson();

    const absoluteSkillsDir = path.resolve(skillsDir);
    const serverPath = path.resolve('./dist/index.js');

    // Verify server exists
    try {
      await fs.access(serverPath);
    } catch {
      throw new Error(`Skilljack MCP server not found at ${serverPath}. Run 'npm run build' first.`);
    }

    options = {
      cwd: process.cwd(),
      mcpServers: {
        skilljack: {
          command: "node",
          args: [serverPath, absoluteSkillsDir]
        }
      },
      systemPrompt: effectiveSystemPrompt,
      settingSources: ['project' as const],
      // Allow both MCP and local skill tools
      allowedTools: ["Bash", "Read", "Write", "Skill", "mcp__skilljack"],
      permissionMode: "default" as const,
      model: modelId
    };
  } else {
    // MCP mode: use skilljack server only
    const absoluteSkillsDir = path.resolve(skillsDir);
    const serverPath = path.resolve('./dist/index.js');

    // Verify server exists
    try {
      await fs.access(serverPath);
    } catch {
      throw new Error(`Skilljack MCP server not found at ${serverPath}. Run 'npm run build' first.`);
    }

    options = {
      cwd: process.cwd(),
      mcpServers: {
        skilljack: {
          command: "node",
          args: [serverPath, absoluteSkillsDir]
        }
      },
      systemPrompt: effectiveSystemPrompt,
      allowedTools: ["mcp__skilljack"],
      permissionMode: "default" as const,
      model: modelId
    };
  }

  return options;
}
