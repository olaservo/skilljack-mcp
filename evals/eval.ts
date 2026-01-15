// Skill eval harness - tests skill discovery, activation, and instruction following
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import {
  displayMetrics,
  createMetricsData,
  SessionLogger
} from "./lib/metrics.js";
import { analyzeSession, printEvalResult, EvalConfig } from "./lib/eval-checker.js";
import { buildOptions } from "./lib/options-builder.js";

interface CLIArgs {
  task: string;
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
  let model: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--task=")) {
      task = arg.split("=")[1];
    } else if (arg.startsWith("--model=")) {
      model = arg.split("=")[1];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: tsx evals/eval.ts [options]

Options:
  --task=<task-name>   Specify the eval task to run (default: greeting)
                       Available: greeting, code-style
  --model=<model-id>   Specify the Claude model to use
  --help, -h           Show this help message

Examples:
  tsx evals/eval.ts                        # Run default task
  tsx evals/eval.ts --task=greeting        # Run greeting task
  tsx evals/eval.ts --task=code-style      # Run code style task
`);
      process.exit(0);
    }
  }

  return { task, model };
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

async function main() {
  const { task: taskName, model } = parseArgs();
  const startTime = Date.now();

  console.log("=== Skill Eval ===\n");

  // Load task configuration
  console.log(`Loading task: ${taskName}`);
  const taskConfig = await loadTask(taskName);

  // Build options with skilljack MCP server
  // Uses Claude Code default system prompt unless task specifies a custom one
  const options = await buildOptions({
    systemPrompt: taskConfig.systemPrompt,
    model,
    skillsDir: './evals/skills'
  });

  console.log(`\nMCP Servers: ${Object.keys(options.mcpServers).join(', ')}`);
  console.log(`Model: ${options.model}`);
  console.log(`Start time: ${new Date(startTime).toISOString()}\n`);

  // Create session logger
  const logger = new SessionLogger(taskName);
  console.log(`Session ID: ${logger.getSessionId()}\n`);

  let resultMessage: SDKResultMessage | null = null;
  let currentToolName: string | null = null;
  let error: Error | null = null;

  try {
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
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    console.error("\n[Error]", error);
    logger.addEntry('error', { message: error.message });
    logger.markAsError(error.message);
  } finally {
    console.log("\n=== Eval complete ===");
    console.log(`End time: ${new Date().toISOString()}`);

    // Analyze session for eval results
    const evalResult = analyzeSession(logger.getEntries(), taskConfig.evalConfig);
    logger.setEvalResult(evalResult);
    printEvalResult(evalResult, taskName, taskConfig.evalConfig);

    // Display and save metrics
    if (resultMessage) {
      displayMetrics(resultMessage, startTime);
      const metrics = createMetricsData(resultMessage, taskName, startTime);
      logger.setMetrics(metrics);
    }

    // Save session log
    const logPath = await logger.save();
    console.log(`\nSession log saved to: ${logPath}`);
    console.log(`Human-readable log: ${logPath.replace('.json', '.md')}`);

    // Save result summary
    await saveResultSummary(taskName, evalResult, logger.getSessionId(), taskConfig.evalConfig);

    if (error) {
      throw error;
    }
  }
}

async function saveResultSummary(
  taskName: string,
  evalResult: ReturnType<typeof analyzeSession>,
  sessionId: string,
  evalConfig: EvalConfig
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
