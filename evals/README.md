# Skill Evals

Evaluation scripts for testing skill activation, progressive disclosure, and instruction following using the Claude Agent SDK.

## Purpose

These evals provide baselines for comparing native vs tool-based skill support across different agents and configurations.

## Setup

```bash
# Install dependencies (including claude-agent-sdk)
npm install

# Build the skilljack server
npm run build
```

## Running Evals

```bash
# Run default eval (greeting)
npm run eval

# Run specific eval
npm run eval:greeting
npm run eval:code-style
npm run eval:template

# Run with custom model
npm run eval -- --model=claude-haiku-4-5-20251001
```

## Test Cases

| Test | Activation | Resource Load | Following | Tests |
|------|------------|---------------|-----------|-------|
| **greeting** | ✓ | - | ✓ | Basic skill activation |
| **code-style** | ✓ | - | ✓ | Skill activation for code tasks |
| **template-generator** | ✓ | ✓ | ✓ | Progressive disclosure (skill → resource) |

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

- **Activation**: Agent calls `skill` tool with correct skill name
- **Resource Load**: Agent calls `skill-resource` tool (when `expectResourceLoad: true`)
- **Following**: Final output contains the expected marker from skill instructions

## Notes

- Uses Claude Code's default system prompt (no custom tuning)
- Logs and results are gitignored but preserved locally for analysis
- Custom system prompts can be added per-task via `systemPrompt` field in task config

## Future Work

- Test on additional clients that support required MCP capabilities (`tools/listChanged`) and agent skills
- Compare tool-based skill activation vs native skill file support across different agents
