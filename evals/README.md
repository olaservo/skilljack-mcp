# Skill Evals

Evaluation scripts for testing skill activation, progressive disclosure, and instruction following using the Claude Agent SDK.

## Purpose

These evals provide baselines for comparing native vs tool-based (MCP) skill support across different agents and configurations.

## Setup

```bash
# Install dependencies (including claude-agent-sdk)
npm install

# Build the skilljack server (required for MCP mode)
npm run build
```

## Running Evals

```bash
# Run with MCP mode (default)
npm run eval
npm run eval -- --task=greeting --mode=mcp

# Run with native mode (Agent SDK)
npm run eval -- --mode=native
npm run eval -- --task=greeting --mode=native

# Run with CLI Native mode (Claude Code CLI directly)
npm run eval -- --mode=cli-native
npm run eval -- --task=greeting --mode=cli-native

# Run specific tasks
npm run eval:greeting
npm run eval:code-style
npm run eval:template

# Run with custom model
npm run eval -- --model=claude-haiku-4-5-20251001
```

## Modes

| Mode | Skill Delivery | Tool Used | Runtime |
|------|----------------|-----------|---------|
| `mcp` | skilljack MCP server | `mcp__skilljack__skill` | Agent SDK |
| `native` | `.claude/skills/` directory | `Skill` | Agent SDK |
| `cli-native` | `.claude/skills/` directory | `Skill` | Claude Code CLI |
| `mcp+native` | Both MCP server AND `.claude/skills/` | Either tool | Agent SDK |

### MCP Mode (default)
- Skills served via skilljack MCP server
- Requires `npm run build` first
- Tests tool-based skill delivery via Agent SDK

### Native Mode
- Skills copied to `.claude/skills/` before eval
- Uses SDK's native skill discovery (`settingSources`)
- Cleaned up after eval completes
- Tests native skill file support via Agent SDK
- **Note**: Requires `systemPrompt: { type: 'preset', preset: 'claude_code' }` — the SDK's default minimal prompt lacks skill awareness

### CLI Native Mode
- Skills copied to `.claude/skills/` before eval
- Shells out to `claude` CLI directly (non-interactive)
- Tests what Claude Code CLI does automatically with skills
- Useful for comparing CLI behavior vs Agent SDK behavior

### MCP+Native Mode (Combined)
- Both MCP server AND native skills enabled simultaneously
- Skills served via MCP AND copied to `.claude/skills/`
- Tests which delivery mechanism the agent prefers
- Useful for testing real-world scenarios where both are available

## Test Cases

| Test | Activation | Resource Load | Following | Tests |
|------|------------|---------------|-----------|-------|
| **greeting** | ✓ | - | ✓ | Basic skill activation |
| **code-style** | ✓ | - | ✓ | Skill activation for code tasks |
| **template-generator** | ✓ | ✓ | ✓ | Progressive disclosure (skill → resource) |
| **xlsx-openpyxl** | ✓ | - | ✓ | Library selection: openpyxl path |
| **xlsx-formulas** | ✓ | - | ✓ | Formula vs hardcoded guidance |
| **xlsx-financial** | ✓ | - | ✓ | Financial model conventions |
| **xlsx-verify** | ✓ | - | ✓ | Verification workflow |

## Structure

```
evals/
├── eval.ts              # Main eval harness
├── lib/
│   ├── metrics.ts       # Logging and metrics utilities
│   ├── eval-checker.ts  # Pass/fail analysis logic
│   └── options-builder.ts
├── skills/              # Test skills with known behaviors
│   ├── greeting/SKILL.md
│   ├── code-style/SKILL.md
│   └── template-generator/
│       ├── SKILL.md
│       └── templates/config.json
├── tasks/               # Task configs (prompt + expected outcomes)
│   ├── greeting.json
│   ├── code-style.json
│   └── template-generator.json
├── logs/                # Session logs (gitignored)
└── results/             # Result summaries (gitignored)
```

## Adding New Evals

1. Create a test skill in `skills/<name>/SKILL.md` with a unique marker in expected output
2. Create a task config in `tasks/<name>.json`:
   ```json
   {
     "prompt": "User prompt that should trigger the skill",
     "evalConfig": {
       "expectedSkillName": "skill-name",
       "expectedOutput": "UNIQUE_MARKER",
       "expectResourceLoad": false
     }
   }
   ```
3. For progressive disclosure tests, set `expectResourceLoad: true` and include files the skill should load
4. Run with `npm run eval -- --task=<name>`

## Eval Criteria

- **Activation**: Agent calls skill tool with correct skill name
- **Resource Load**: Agent calls skill-resource tool (MCP mode only, when `expectResourceLoad: true`)
- **Following**: Final output contains the expected marker from skill instructions

## Notes

- Uses Claude Code's default system prompt (no custom tuning)

### Observed Behaviors

**"Noodling" without skill activation**: In some modes, the agent may explore the codebase (Glob, Read, Bash) to find skill files directly rather than using the skill tool. This is less efficient but can still achieve the goal. Current evals don't count this as "activation" - only explicit skill tool calls are tracked.

**Context duplication in mcp+native mode**: When both MCP and native skills are enabled, the same skill appears twice (via MCP tool description AND `.claude/skills/` files). This may cause context bloat and could affect which mechanism the agent chooses.

**Activation differences by mode**: Initial testing shows native mode may activate skills more readily than MCP mode for the same prompts. This could be due to system prompt differences or how skills are presented to the agent.
- Logs and results are gitignored but preserved locally for analysis
- Custom system prompts can be added per-task via `systemPrompt` field in task config
- Session IDs include mode prefix for easy comparison (e.g., `mcp-greeting-*` vs `native-greeting-*` vs `cli-native-greeting-*`)

## Future Work

- Test on additional clients that support required MCP capabilities (`tools/listChanged`) and agent skills
- Compare tool-based skill activation vs native skill file support across different agents
- Add resource loading detection for native mode if SDK supports it
