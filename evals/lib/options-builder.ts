// Options builder for skill evals
import * as path from "path";
import * as fs from "fs/promises";

export interface BuildOptionsConfig {
  systemPrompt?: string;  // Optional - uses Claude Code default if not provided
  model?: string;
  skillsDir: string;  // Path to test skills directory
}

/**
 * Build query options for skill eval
 */
export async function buildOptions(config: BuildOptionsConfig): Promise<any> {
  const { systemPrompt, model, skillsDir } = config;

  // Default to Sonnet 4.5
  const modelId = model || "claude-sonnet-4-5-20250929";

  // Get absolute path to skills directory
  const absoluteSkillsDir = path.resolve(skillsDir);

  // Get the built skilljack-mcp server path
  const serverPath = path.resolve('./dist/index.js');

  // Verify server exists
  try {
    await fs.access(serverPath);
  } catch {
    throw new Error(`Skilljack MCP server not found at ${serverPath}. Run 'npm run build' first.`);
  }

  const options: Record<string, unknown> = {
    cwd: process.cwd(),
    mcpServers: {
      skilljack: {
        command: "node",
        args: [serverPath, absoluteSkillsDir]
      }
    },
    // Allow MCP tools from skilljack server
    allowedTools: ["mcp__skilljack"],
    permissionMode: "default" as const,
    model: modelId
  };

  // Only include systemPrompt if provided (otherwise use Claude Code default)
  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }

  return options;
}
