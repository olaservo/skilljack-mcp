// Options builder for skill evals
import * as path from "path";
import * as fs from "fs/promises";

export type EvalMode = "mcp" | "native" | "cli-native" | "mcp+native";

export interface BuildOptionsConfig {
  mode: EvalMode;
  systemPrompt?: string;  // Optional - uses Claude Code default if not provided
  model?: string;
  skillsDir: string;  // Path to test skills directory
}

/**
 * Copy skills to .claude/skills/ for native mode
 */
export async function setupNativeSkills(skillsDir: string): Promise<void> {
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
 * Ensure .claude/settings.json exists for native skill discovery
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
 * Clean up .claude/skills/ after native mode
 */
export async function cleanupNativeSkills(): Promise<void> {
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

  // Default to Sonnet 4.5
  const modelId = model || "claude-sonnet-4-5-20250929";

  let options: Record<string, unknown>;

  if (mode === "cli-native") {
    // CLI Native mode: set up skills in .claude/skills/ for CLI to discover
    await setupNativeSkills(skillsDir);
    await ensureSettingsJson();

    // Return minimal options - CLI will use its own defaults
    options = {
      cwd: process.cwd(),
      model: modelId
    };
  } else if (mode === "native") {
    // Native mode: use settingSources and Skill tool
    // Must use claude_code preset to get skill awareness in system prompt
    await setupNativeSkills(skillsDir);
    await ensureSettingsJson();

    options = {
      cwd: process.cwd(),
      // Use Claude Code's system prompt which includes skill awareness
      // Without this preset, the SDK uses a minimal prompt without skill instructions
      systemPrompt: systemPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt }
        : { type: 'preset' as const, preset: 'claude_code' as const },
      settingSources: ['project' as const],
      allowedTools: ["Bash", "Read", "Write", "Skill"],
      permissionMode: "default" as const,
      model: modelId
    };
  } else if (mode === "mcp+native") {
    // Combined mode: both MCP server AND native skills enabled
    // Tests behavior when both skill delivery mechanisms are available
    await setupNativeSkills(skillsDir);
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
      // Use Claude Code's system prompt for skill awareness
      systemPrompt: systemPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt }
        : { type: 'preset' as const, preset: 'claude_code' as const },
      settingSources: ['project' as const],
      // Allow both MCP and native skill tools
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
      allowedTools: ["mcp__skilljack"],
      permissionMode: "default" as const,
      model: modelId
    };
  }

  // For MCP mode, optionally include custom systemPrompt
  // (native mode already handles systemPrompt with the claude_code preset above)
  if (mode === "mcp" && systemPrompt) {
    options.systemPrompt = systemPrompt;
  }

  return options;
}
