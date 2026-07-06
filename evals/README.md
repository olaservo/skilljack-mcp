# Skill Evals

Evaluation scripts for testing skill activation, progressive disclosure, and instruction following using the Claude Agent SDK.

## Purpose

These evals provide baselines for comparing local (filesystem) vs tool-based (MCP) skill support across different agents and configurations.

## Setup

```bash
# Install dependencies (including claude-agent-sdk)
npm install

# Build the skilljack server (required for MCP mode)
npm run build
```

## MCP-mode setup (important)

On agent-sdk 0.3.x, MCP-mode evals only measure skill activation meaningfully after working around **two independent regressions** (the harness does this automatically — see `lib/options-builder.ts`):

1. **stdio connect race** — the SDK connects stdio MCP servers *asynchronously*, so a stdio skilljack is still `pending` at the model's first turn and its tools are absent (upstream [anthropics/claude-code#49753](https://github.com/anthropics/claude-code/issues/49753)). The harness runs skilljack over **HTTP** (`--http=0`, ephemeral port) instead of stdio so it is `connected` on turn 1.
2. **tool search / deferred tools** — MCP tool *descriptions* are deferred out of context, so in `--catalog=tool-description` mode the model never sees skilljack's `<available_skills>` catalog and won't activate. The default `instructions` catalog mode is immune (the catalog arrives via the `initialize` handshake), but the harness still sets **`ENABLE_TOOL_SEARCH=false`** by default for uniform tool visibility across modes; override with `--tool-search=on`.

### Catalog-channel knobs (`--catalog` + `--tool-search`)

Skilljack delivers the skill catalog through exactly one channel: server `instructions` (default) or the `load-skill` tool description — see `--catalog=` in the main README. Server `instructions` arrive in the `initialize` handshake rather than a (deferrable) tool description, which is why they survive tool search ON. The harness exposes both knobs:

```bash
# Default catalog (instructions), tool search ENABLED — passes
npm run eval -- --task=code-style --mode=mcp --tool-search=on

# Catalog via tool description, tool search ENABLED (fails — description is deferred)
npm run eval -- --task=code-style --mode=mcp --catalog=tool-description --tool-search=on
```

`--catalog` is passed to the spawned skilljack server (MCP modes only); `--tool-search` sets `ENABLE_TOOL_SEARCH` explicitly (both on and off) on the Agent SDK client env. Both settings are recorded in the result summary JSON.

**Result (2026-07-05, agent-sdk 0.3.201, claude-sonnet-4-6):** the instructions channel survives tool search — this is why it became the default. With the default catalog (no `--catalog` flag) and `--tool-search=on`, all 3 tasks pass (code-style, template-generator, xlsx-openpyxl — all of which fail in tool-description mode with tool search on); the tool-description + tool-search-on control failed as expected; tool-description + tool-search-off also passes. Reproduced across two batches, including one exercising the HTTP discovery-on-change path.

**Caching/cost (2026-07-06, 8-cell matrix, 1 rep/cell):** the default (instructions + tool search ON) is also the cheapest *passing* configuration by ~3.5–6× ($0.15–0.21 vs $0.73–0.94 per run). The cost driver is `ENABLE_TOOL_SEARCH=off`, not the catalog channel: with tool search off, all tool definitions load upfront (~120–144k cache-creation tokens per run) regardless of catalog mode. Token/cache/cost metrics are persisted per run in both the session log (`evals/logs/`) and the result summary (`evals/results/`). Full table: [issue #78](https://github.com/olaservo/skilljack-mcp/issues/78).

## Running Evals

```bash
# Run with MCP mode (default)
npm run eval
npm run eval -- --task=greeting --mode=mcp

# Run with local mode (Agent SDK)
npm run eval -- --mode=local
npm run eval -- --task=greeting --mode=local

# Run with CLI Local mode (Claude Code CLI directly)
npm run eval -- --mode=cli-local
npm run eval -- --task=greeting --mode=cli-local

# Run specific tasks
npm run eval:greeting
npm run eval:code-style
npm run eval:template

# Run with custom model
npm run eval -- --model=claude-haiku-4-5
```

## Modes

| Mode | Skill Delivery | Tool Used | Runtime |
|------|----------------|-----------|---------|
| `mcp` | skilljack MCP server | `mcp__skilljack__skill` | Agent SDK |
| `local` | `.claude/skills/` directory | `Skill` | Agent SDK |
| `cli-local` | `.claude/skills/` directory | `Skill` | Claude Code CLI |
| `mcp+local` | Both MCP server AND `.claude/skills/` | Either tool | Agent SDK |

### MCP Mode (default)
- Skills served via skilljack MCP server
- Requires `npm run build` first
- Tests tool-based skill delivery via Agent SDK

### Local Mode
- Skills copied to `.claude/skills/` before eval
- Uses SDK's local skill discovery (`settingSources`)
- Cleaned up after eval completes
- Tests local skill file support via Agent SDK
- **Note**: Requires `systemPrompt: { type: 'preset', preset: 'claude_code' }` — the SDK's default minimal prompt lacks skill awareness

### CLI Local Mode
- Skills copied to `.claude/skills/` before eval
- Shells out to `claude` CLI directly (non-interactive)
- Tests what Claude Code CLI does automatically with skills
- Useful for comparing CLI behavior vs Agent SDK behavior

### MCP+Local Mode (Combined)
- Both MCP server AND local skills enabled simultaneously
- Skills served via MCP AND copied to `.claude/skills/`
- Tests which delivery mechanism the agent prefers
- Useful for testing real-world scenarios where both are available

## Test Cases

| Test | Activation | Resource Load | Following | Tests |
|------|------------|---------------|-----------|-------|
| **greeting** | ✓ | - | ✓ | Basic skill activation |
| **code-style** | ✓ | - | ✓ | Skill activation for code tasks |
| **template-generator** | ✓ | ✓ | ✓ | Progressive disclosure (skill → resource) |
| **xlsx-openpyxl** | ✓ | - | ✓ | Excel formulas/formatting |
| **xlsx-formulas** | ✓ | - | ✓ | Formula vs hardcoded guidance |
| **xlsx-financial** | ✓ | - | ✓ | Financial model conventions |
| **xlsx-verify** | ✓ | - | ✓ | Verification workflow |

## Test Skills

- **xlsx**: Real skill from the official Anthropic skills repository: https://github.com/anthropics/skills/tree/main/skills/xlsx
- **greeting**, **code-style**, **template-generator**: Synthetic skills created for eval testing with marker phrases (e.g., `SKILLJACK_GREETING_SUCCESS`) for verifiable pass/fail criteria

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

**Context duplication in mcp+local mode**: When both MCP and local skills are enabled, the same skill appears twice (via MCP tool description AND `.claude/skills/` files). This may cause context bloat and could affect which mechanism the agent chooses.

**Activation differences by mode**: Initial testing showed local mode activated skills more readily than MCP mode for the same prompts. Investigation revealed this is due to the local Skill tool description containing explicit activation triggers:

> "When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action"
> "NEVER just announce or mention a skill in your text response without actually calling this tool"
> "This is a BLOCKING REQUIREMENT"

Source: [Unofficial Claude Code system prompts](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-skill.md)

**Solution**: Adding similar language to the MCP skill tool description brings activation behavior in line with local mode. The skilljack MCP server now includes these activation triggers in its tool description.
- Logs and results are gitignored but preserved locally for analysis
- Custom system prompts can be added per-task via `systemPrompt` field in task config
- Session IDs include mode prefix for easy comparison (e.g., `mcp-greeting-*` vs `local-greeting-*` vs `cli-local-greeting-*`)

## Future Work

- Test on additional clients that support required MCP capabilities (`tools/listChanged`) and agent skills
- Compare tool-based skill activation vs local skill file support across different agents
- Add resource loading detection for local mode if SDK supports it
