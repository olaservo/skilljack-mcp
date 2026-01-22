// Metrics display and logging utilities for skill evals
import { type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";

export interface SessionLogEntry {
  timestamp: string;
  type: string;
  data: unknown;
}

export interface EvalResult {
  discovered: boolean;      // Did agent identify the skill before calling tool?
  activated: boolean;       // Did agent call the skill tool?
  skillName?: string;       // Which skill was activated (if any)
  resourceLoaded: boolean;  // Did agent call skill-resource tool?
  followed: boolean;        // Did agent follow skill instructions?
  followedReason?: string;  // Why we think instructions were/weren't followed
}

export interface SessionLog {
  sessionId: string;
  task: string;
  startTime: string;
  endTime?: string;
  status: 'success' | 'error';
  errorMessage?: string;
  entries: SessionLogEntry[];
  metrics?: MetricsData;
  evalResult?: EvalResult;
}

export class SessionLogger {
  private log: SessionLog;
  private logDir: string;

  constructor(task: string, logDir: string = './evals/logs', mode: string = 'mcp') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logDir = logDir;
    this.log = {
      sessionId: `${mode}-${task}-${timestamp}`,
      task,
      startTime: new Date().toISOString(),
      status: 'success',
      entries: []
    };
  }

  addEntry(type: string, data: unknown): void {
    this.log.entries.push({
      timestamp: new Date().toISOString(),
      type,
      data
    });
  }

  addTextMessage(text: string): void {
    this.addEntry('text', { text });
  }

  addToolUse(name: string, input: unknown): void {
    this.addEntry('tool_use', { name, input });
  }

  addToolResult(name: string, success: boolean): void {
    this.addEntry('tool_result', { name, success });
  }

  addAssistantMessage(content: unknown[]): void {
    this.addEntry('assistant', { content });
  }

  setMetrics(metrics: MetricsData): void {
    this.log.metrics = metrics;
  }

  setEvalResult(result: EvalResult): void {
    this.log.evalResult = result;
  }

  markAsError(errorMessage: string): void {
    this.log.status = 'error';
    this.log.errorMessage = errorMessage;
  }

  getEntries(): SessionLogEntry[] {
    return this.log.entries;
  }

  async save(): Promise<string> {
    this.log.endTime = new Date().toISOString();

    // Ensure log directory exists
    await fs.mkdir(this.logDir, { recursive: true });

    const prefix = this.log.status === 'error' ? 'FAILED__' : '';
    const filename = `${prefix}${this.log.sessionId}.json`;
    const filepath = path.join(this.logDir, filename);

    await fs.writeFile(filepath, JSON.stringify(this.log, null, 2));

    // Also save a human-readable version
    const readableFilepath = path.join(this.logDir, `${prefix}${this.log.sessionId}.md`);
    await fs.writeFile(readableFilepath, this.generateReadableLog());

    return filepath;
  }

  private generateReadableLog(): string {
    const lines: string[] = [];

    lines.push(`# Eval Session: ${this.log.sessionId}`);
    lines.push(`**Task:** ${this.log.task}`);
    lines.push(`**Start:** ${this.log.startTime}`);
    lines.push(`**End:** ${this.log.endTime || 'In progress'}`);
    const statusIcon = this.log.status === 'success' ? '✓' : '✗';
    lines.push(`**Status:** ${statusIcon} ${this.log.status}`);
    if (this.log.errorMessage) {
      lines.push(`**Error:** ${this.log.errorMessage}`);
    }
    lines.push('');

    // Eval results
    if (this.log.evalResult) {
      lines.push('## Eval Results');
      const r = this.log.evalResult;
      lines.push(`- **Activated:** ${r.activated ? '✓' : '✗'}${r.skillName ? ` (${r.skillName})` : ''}`);
      lines.push(`- **Resource Loaded:** ${r.resourceLoaded ? '✓' : '✗'}`);
      lines.push(`- **Followed:** ${r.followed ? '✓' : '✗'}${r.followedReason ? ` - ${r.followedReason}` : ''}`);
      lines.push('');
    }

    if (this.log.metrics) {
      lines.push('## Metrics Summary');
      lines.push(`- **Duration:** ${formatDuration(this.log.metrics.timing.totalElapsedMs)}`);
      lines.push(`- **Cost:** $${this.log.metrics.cost.toFixed(6)}`);
      lines.push(`- **Turns:** ${this.log.metrics.turns}`);
      lines.push(`- **Total Tokens:** ${this.log.metrics.tokens.total.toLocaleString()}`);
      lines.push('');
    }

    lines.push('## Session Events');
    lines.push('');

    let toolUseCount = 0;
    for (const entry of this.log.entries) {
      const time = new Date(entry.timestamp).toISOString().split('T')[1].split('.')[0];

      switch (entry.type) {
        case 'text': {
          const data = entry.data as { text: string };
          const preview = data.text.length > 500 ? data.text.substring(0, 500) + '...' : data.text;
          lines.push(`### [${time}] Assistant Text`);
          lines.push('```');
          lines.push(preview);
          lines.push('```');
          lines.push('');
          break;
        }
        case 'tool_use': {
          toolUseCount++;
          const data = entry.data as { name: string; input: unknown };
          lines.push(`### [${time}] Tool Use #${toolUseCount}: ${data.name}`);
          const inputStr = JSON.stringify(data.input, null, 2);
          const inputPreview = inputStr.length > 1000 ? inputStr.substring(0, 1000) + '\n... (truncated)' : inputStr;
          lines.push('```json');
          lines.push(inputPreview);
          lines.push('```');
          lines.push('');
          break;
        }
        case 'tool_result': {
          const data = entry.data as { name: string; success: boolean };
          lines.push(`### [${time}] Tool Result: ${data.name}`);
          lines.push(`Status: ${data.success ? '✓ Success' : '✗ Failed'}`);
          lines.push('');
          break;
        }
        case 'assistant': {
          const data = entry.data as { content: unknown[] };
          lines.push(`### [${time}] Assistant Message`);
          for (const chunk of data.content) {
            if (typeof chunk === 'object' && chunk !== null) {
              const c = chunk as { type: string; text?: string; name?: string };
              if (c.type === 'text' && c.text) {
                const preview = c.text.length > 500 ? c.text.substring(0, 500) + '...' : c.text;
                lines.push('```');
                lines.push(preview);
                lines.push('```');
              } else if (c.type === 'tool_use' && c.name) {
                lines.push(`Tool call: ${c.name}`);
              }
            }
          }
          lines.push('');
          break;
        }
        default:
          lines.push(`### [${time}] ${entry.type}`);
          lines.push('```json');
          lines.push(JSON.stringify(entry.data, null, 2).substring(0, 500));
          lines.push('```');
          lines.push('');
      }
    }

    lines.push('---');
    lines.push(`Total tool uses: ${toolUseCount}`);

    return lines.join('\n');
  }

  getSessionId(): string {
    return this.log.sessionId;
  }
}

export interface MetricsData {
  timestamp: string;
  task: string;
  timing: {
    totalElapsedMs: number;
    sdkDurationMs: number;
    apiDurationMs: number;
    overheadMs: number;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  cost: number;
  turns: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }
}

export function displayMetrics(result: SDKResultMessage, startTime: number): void {
  const totalElapsed = Date.now() - startTime;

  console.log("\n" + "=".repeat(50));
  console.log("              EXECUTION METRICS");
  console.log("=".repeat(50));

  console.log("\n--- Timing ---");
  console.log(`Total Elapsed Time:     ${formatDuration(totalElapsed)}`);
  console.log(`SDK Duration:           ${formatDuration(result.duration_ms)}`);
  console.log(`API Call Time:          ${formatDuration(result.duration_api_ms)}`);
  console.log(`Overhead Time:          ${formatDuration(result.duration_ms - result.duration_api_ms)}`);

  console.log("\n--- Token Usage ---");
  console.log(`Input Tokens:           ${result.usage.input_tokens.toLocaleString()}`);
  console.log(`Output Tokens:          ${result.usage.output_tokens.toLocaleString()}`);
  console.log(`Cache Read Tokens:      ${result.usage.cache_read_input_tokens.toLocaleString()}`);
  console.log(`Cache Creation Tokens:  ${result.usage.cache_creation_input_tokens.toLocaleString()}`);

  console.log("\n--- Cost & Turns ---");
  console.log(`Total Cost:             $${result.total_cost_usd.toFixed(6)}`);
  console.log(`Number of Turns:        ${result.num_turns}`);

  console.log("\n" + "=".repeat(50));
}

export function createMetricsData(
  result: SDKResultMessage,
  task: string,
  startTime: number
): MetricsData {
  return {
    timestamp: new Date().toISOString(),
    task,
    timing: {
      totalElapsedMs: Date.now() - startTime,
      sdkDurationMs: result.duration_ms,
      apiDurationMs: result.duration_api_ms,
      overheadMs: result.duration_ms - result.duration_api_ms
    },
    tokens: {
      input: result.usage.input_tokens,
      output: result.usage.output_tokens,
      cacheRead: result.usage.cache_read_input_tokens,
      cacheCreation: result.usage.cache_creation_input_tokens,
      total: result.usage.input_tokens + result.usage.output_tokens
    },
    cost: result.total_cost_usd,
    turns: result.num_turns,
    modelUsage: result.modelUsage
  };
}
