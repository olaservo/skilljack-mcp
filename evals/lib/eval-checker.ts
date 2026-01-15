// Eval result checker - analyzes session logs to determine pass/fail
import type { SessionLogEntry, EvalResult } from "./metrics.js";

export interface EvalConfig {
  expectedSkillName: string;
  expectedOutput?: string | RegExp;  // What the final output should contain/match
  expectResourceLoad?: boolean;       // Should agent load a skill resource?
}

/**
 * Analyze session entries to determine eval results
 */
export function analyzeSession(entries: SessionLogEntry[], config: EvalConfig): EvalResult {
  let discovered = false;
  let activated = false;
  let skillName: string | undefined;
  let resourceLoaded = false;
  let followed = false;
  let followedReason: string | undefined;

  // Track text before first skill tool call to check for discovery
  let textBeforeSkillCall = '';
  let skillToolCalled = false;
  let finalOutput = '';

  for (const entry of entries) {
    // Collect text messages
    if (entry.type === 'text') {
      const data = entry.data as { text: string };
      if (!skillToolCalled) {
        textBeforeSkillCall += ' ' + data.text;
      }
      finalOutput = data.text; // Keep updating to get last text
    }

    // Check assistant messages for text content and tool_use
    if (entry.type === 'assistant') {
      const data = entry.data as { content: unknown[] };
      for (const chunk of data.content) {
        if (typeof chunk === 'object' && chunk !== null) {
          const c = chunk as { type: string; text?: string; name?: string; input?: unknown };
          if (c.type === 'text' && c.text) {
            if (!skillToolCalled) {
              textBeforeSkillCall += ' ' + c.text;
            }
            finalOutput = c.text;
          }
          // Check for tool_use inside assistant message
          if (c.type === 'tool_use' && c.name) {
            if (c.name.includes('skill-resource')) {
              resourceLoaded = true;
            } else if (c.name.includes('skill')) {
              skillToolCalled = true;
              activated = true;
              const input = c.input as { name?: string };
              skillName = input?.name;
            }
          }
        }
      }
    }

    // Check for top-level skill tool calls (some SDK versions emit these separately)
    if (entry.type === 'tool_use') {
      const data = entry.data as { name: string; input: unknown };

      // Check for MCP skill-resource tool
      if (data.name.includes('skill-resource')) {
        resourceLoaded = true;
      }
      // Check for MCP skill tool (mcp__skilljack__skill or similar patterns)
      else if (data.name.includes('skill')) {
        skillToolCalled = true;
        activated = true;
        const input = data.input as { name?: string };
        skillName = input.name;
      }
    }
  }

  // Discovery = activation (if agent called the skill, it discovered it)
  discovered = activated;

  // Check if correct skill was activated
  if (activated && skillName !== config.expectedSkillName) {
    activated = false; // Wrong skill
    skillName = undefined;
  }

  // Check if instructions were followed (based on expected output)
  if (config.expectedOutput) {
    if (typeof config.expectedOutput === 'string') {
      if (finalOutput.toLowerCase().includes(config.expectedOutput.toLowerCase())) {
        followed = true;
        followedReason = `Output contains expected text: "${config.expectedOutput}"`;
      } else {
        followedReason = `Output missing expected text: "${config.expectedOutput}"`;
      }
    } else {
      // RegExp
      if (config.expectedOutput.test(finalOutput)) {
        followed = true;
        followedReason = `Output matches pattern: ${config.expectedOutput}`;
      } else {
        followedReason = `Output does not match pattern: ${config.expectedOutput}`;
      }
    }
  } else {
    // No expected output specified, assume followed if skill was activated
    followed = activated;
    followedReason = activated ? 'Skill was activated (no output check)' : 'Skill was not activated';
  }

  return {
    discovered,
    activated,
    skillName: activated ? skillName : undefined,
    resourceLoaded,
    followed,
    followedReason
  };
}

/**
 * Print eval result summary
 */
export function printEvalResult(result: EvalResult, taskName: string, config?: EvalConfig): void {
  console.log("\n" + "=".repeat(50));
  console.log("              EVAL RESULTS");
  console.log("=".repeat(50));
  console.log(`\nTask: ${taskName}`);
  console.log(`\nActivation:     ${result.activated ? '✓ PASS' : '✗ FAIL'} - Agent ${result.activated ? `called skill tool (${result.skillName})` : 'did not call skill tool'}`);

  // Only show resource loading if expected
  if (config?.expectResourceLoad) {
    console.log(`Resource Load:  ${result.resourceLoaded ? '✓ PASS' : '✗ FAIL'} - Agent ${result.resourceLoaded ? 'called skill-resource tool' : 'did not call skill-resource tool'}`);
  }

  console.log(`Following:      ${result.followed ? '✓ PASS' : '✗ FAIL'} - ${result.followedReason || 'Unknown'}`);

  let passed = result.activated && result.followed;
  if (config?.expectResourceLoad) {
    passed = passed && result.resourceLoaded;
  }
  console.log(`\nOverall: ${passed ? '✓ PASS' : '✗ FAIL'}`);
  console.log("=".repeat(50));
}
