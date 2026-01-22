// Skill eval harness - tests skill discovery, activation, and instruction following
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import {
  displayMetrics,
  createMetricsData,
  SessionLogger
} from "./lib/metrics.js";
import { analyzeSession, printEvalResult, EvalConfig } from "./lib/eval-checker.js";
import { buildOptions, cleanupNativeSkills, EvalMode } from "./lib/options-builder.js";

interface CLIArgs {
  task: string;
  mode: EvalMode;
  model?: string;
}

interface TaskConfig {
  prompt: string;
  evalConfig: EvalConfig;
  systemPrompt?: string;  // Optional custom system prompt
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  let task = "greeting"; // default
  let mode: EvalMode = "mcp"; // default
  let model: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--task=")) {
      task = arg.split("=")[1];
    } else if (arg.startsWith("--mode=")) {
      const modeArg = arg.split("=")[1];
      if (modeArg === "native" || modeArg === "mcp" || modeArg === "cli-native" || modeArg === "mcp+native") {
        mode = modeArg;
      } else {
        console.error(`Invalid mode: ${modeArg}. Use 'mcp', 'native', 'cli-native', or 'mcp+native'.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--model=")) {
      model = arg.split("=")[1];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: tsx evals/eval.ts [options]

Options:
  --task=<task-name>   Specify the eval task to run (default: greeting)
                       Available: greeting, code-style, template-generator
  --mode=<mcp|native|cli-native|mcp+native>  Skill delivery mode (default: mcp)
                       mcp: Use skilljack MCP server via Agent SDK
                       native: Use native .claude/skills/ via Agent SDK
                       cli-native: Use Claude Code CLI directly (non-interactive)
                       mcp+native: Both MCP server AND native skills enabled
  --model=<model-id>   Specify the Claude model to use
  --help, -h           Show this help message

Examples:
  tsx evals/eval.ts                          # Run default task with MCP
  tsx evals/eval.ts --mode=native            # Run with native skills via SDK
  tsx evals/eval.ts --mode=cli-native        # Run with Claude Code CLI directly
  tsx evals/eval.ts --mode=mcp+native        # Run with both MCP and native skills
  tsx evals/eval.ts --task=greeting --mode=mcp
  tsx evals/eval.ts --task=code-style --mode=cli-native
`);
      process.exit(0);
    }
  }

  return { task, mode, model };
}

async function loadTask(taskName: string): Promise<TaskConfig> {
  const taskPath = path.join('./evals/tasks', `${taskName}.json`);

  try {
    const content = await fs.readFile(taskPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Task not found: ${taskPath}`);
  }
}

interface CLIResult {
  output: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  error?: string;
}

/**
 * Run prompt using Claude Code CLI directly
 */
async function runWithCLI(prompt: string, model: string): Promise<CLIResult> {
  // Use claude CLI with -p for non-interactive mode and --output-format for streaming JSON
  // stream-json gives us individual messages as they arrive (requires --verbose)
  // Escape the prompt for shell usage
  const escapedPrompt = prompt.replace(/"/g, '\\"');
  const cmd = `claude -p --output-format stream-json --verbose --model ${model} --dangerously-skip-permissions -- "${escapedPrompt}"`;

  console.log(`\nRunning: claude -p --output-format stream-json --verbose --model ${model} --dangerously-skip-permissions -- "<prompt>"\n`);

  let stdout = '';
  let error: string | undefined;

  try {
    stdout = execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
      timeout: 120000  // 2 minute timeout
    });
    console.log(stdout);
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string; message?: string };
    // execSync throws on non-zero exit, but might still have useful output
    if (execError.stdout) {
      stdout = execError.stdout;
      console.log(stdout);
    }
    error = execError.stderr || execError.message || 'Unknown error';
    console.error(`\nCLI error: ${error}`);
  }

  console.log(`\n[CLI completed]`);

  // Parse JSON output from CLI
  const result = parseCLIOutput(stdout);
  if (error && !result.error) {
    result.error = error;
  }

  return result;
}

/**
 * Parse Claude CLI stream-json output to extract text and tool calls
 *
 * stream-json format outputs one JSON object per line with various message types:
 * - init: session initialization
 * - system_prompt: system prompt info
 * - assistant: assistant messages with content array
 * - user: user messages
 * - result: final result
 */
function parseCLIOutput(output: string): CLIResult {
  const result: CLIResult = {
    output: '',
    toolCalls: []
  };

  try {
    // CLI with --output-format stream-json outputs JSON lines
    const lines = output.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);

        // Handle different message types from CLI stream-json output
        if (parsed.type === 'text') {
          result.output += (parsed.text || '') + '\n';
        } else if (parsed.type === 'result') {
          // Result message has the final text
          if (parsed.result) {
            result.output = parsed.result;  // Use result as final output
          }
        } else if (parsed.type === 'tool_use') {
          result.toolCalls.push({
            name: parsed.name,
            input: parsed.input
          });
        } else if (parsed.type === 'assistant' && parsed.message?.content) {
          // Handle assistant messages with content array
          for (const chunk of parsed.message.content) {
            if (chunk.type === 'text') {
              result.output += chunk.text + '\n';
            } else if (chunk.type === 'tool_use') {
              result.toolCalls.push({
                name: chunk.name,
                input: chunk.input
              });
            }
          }
        }
      } catch {
        // Not JSON, might be plain text or partial line
        // Skip non-JSON lines in stream-json mode
      }
    }
  } catch (err) {
    result.error = `Failed to parse CLI output: ${err}`;
    result.output = output;  // Keep raw output
  }

  return result;
}

async function main() {
  const { task: taskName, mode, model } = parseArgs();
  const startTime = Date.now();

  console.log("=== Skill Eval ===\n");

  // Load task configuration
  console.log(`Loading task: ${taskName}`);
  const taskConfig = await loadTask(taskName);

  // Build options based on mode
  const options = await buildOptions({
    mode,
    systemPrompt: taskConfig.systemPrompt,
    model,
    skillsDir: './evals/skills'
  });

  console.log(`\nMode: ${mode}`);
  if (mode === "mcp") {
    console.log(`MCP Servers: ${Object.keys(options.mcpServers || {}).join(', ')}`);
  } else if (mode === "mcp+native") {
    console.log(`MCP Servers: ${Object.keys(options.mcpServers || {}).join(', ')}`);
    console.log(`Skills Source: .claude/skills/ (also enabled)`);
  } else if (mode === "cli-native") {
    console.log(`Using Claude Code CLI directly`);
  } else {
    console.log(`Skills Source: .claude/skills/`);
  }
  console.log(`Model: ${options.model}`);
  console.log(`Start time: ${new Date(startTime).toISOString()}\n`);

  // Create session logger with mode prefix
  const logger = new SessionLogger(taskName, './evals/logs', mode);
  console.log(`Session ID: ${logger.getSessionId()}\n`);

  let resultMessage: SDKResultMessage | null = null;
  let currentToolName: string | null = null;
  let error: Error | null = null;

  try {
    if (mode === "cli-native") {
      // CLI mode: shell out to claude CLI
      const cliResult = await runWithCLI(taskConfig.prompt, options.model);

      // Convert CLI result to session log entries
      if (cliResult.output) {
        logger.addTextMessage(cliResult.output);
        console.log(`\nClaude: ${cliResult.output}`);
      }

      for (const toolCall of cliResult.toolCalls) {
        logger.addToolUse(toolCall.name, toolCall.input);
        console.log(`\n[Tool Use] ${toolCall.name}`);
        const input = JSON.stringify(toolCall.input || {}, null, 2);
        const preview = input.length > 200 ? input.substring(0, 200) + "..." : input;
        console.log(`Input: ${preview}`);
      }

      if (cliResult.error) {
        console.error("\n[CLI Error]", cliResult.error);
        logger.addEntry('error', { message: cliResult.error });
      }
    } else {
      // SDK mode: use query() function
      for await (const message of query({ prompt: taskConfig.prompt, options })) {
        if (message.type === "text") {
          console.log(`\nClaude: ${message.text}`);
          logger.addTextMessage(message.text);
        }
        else if (message.type === "assistant") {
          logger.addAssistantMessage(message.message.content);
          for (const chunk of message.message.content) {
            if (chunk.type === 'text') {
              console.log(`\nClaude: ${chunk.text}`);
            }
            if (chunk.type === 'tool_use') {
              console.log(`\n[Tool Use] ${chunk.name}`);
            }
          }
        }
        else if (message.type === "tool_use") {
          currentToolName = message.name;
          logger.addToolUse(message.name, message.input);
          console.log(`\n[Tool Use] ${message.name}`);
          const input = JSON.stringify(message.input || {}, null, 2);
          const preview = input.length > 200 ? input.substring(0, 200) + "..." : input;
          console.log(`Input: ${preview}`);
        }
        else if (message.type === "tool_result") {
          logger.addToolResult(currentToolName || "unknown", true);
          console.log("[Tool Completed]");
          currentToolName = null;
        }
        else if (message.type === "result") {
          resultMessage = message;
          console.log("\n[Final Result]");
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    console.error("\n[Error]", error);
    logger.addEntry('error', { message: error.message });
    logger.markAsError(error.message);
  } finally {
    console.log("\n=== Eval complete ===");
    console.log(`End time: ${new Date().toISOString()}`);

    // Analyze session for eval results
    const evalResult = analyzeSession(logger.getEntries(), taskConfig.evalConfig, mode);
    logger.setEvalResult(evalResult);
    printEvalResult(evalResult, taskName, taskConfig.evalConfig);

    // Display and save metrics (only for SDK modes)
    if (resultMessage && mode !== "cli-native") {
      displayMetrics(resultMessage, startTime);
      const metrics = createMetricsData(resultMessage, taskName, startTime);
      logger.setMetrics(metrics);
    }

    // Save session log
    const logPath = await logger.save();
    console.log(`\nSession log saved to: ${logPath}`);
    console.log(`Human-readable log: ${logPath.replace('.json', '.md')}`);

    // Save result summary
    await saveResultSummary(taskName, evalResult, logger.getSessionId(), taskConfig.evalConfig, mode);

    // Cleanup native skills if in native, cli-native, or mcp+native mode
    if (mode === "native" || mode === "cli-native" || mode === "mcp+native") {
      await cleanupNativeSkills();
    }

    if (error) {
      throw error;
    }
  }
}

async function saveResultSummary(
  taskName: string,
  evalResult: ReturnType<typeof analyzeSession>,
  sessionId: string,
  evalConfig: EvalConfig,
  mode: EvalMode
): Promise<void> {
  const resultsDir = './evals/results';
  await fs.mkdir(resultsDir, { recursive: true });

  let passed = evalResult.activated && evalResult.followed;
  if (evalConfig.expectResourceLoad) {
    passed = passed && evalResult.resourceLoaded;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    task: taskName,
    mode,
    sessionId,
    passed,
    results: evalResult
  };

  const filename = `${sessionId}.json`;
  const filepath = path.join(resultsDir, filename);
  await fs.writeFile(filepath, JSON.stringify(summary, null, 2));
  console.log(`Result summary saved to: ${filepath}`);
}

main().catch(console.error);
