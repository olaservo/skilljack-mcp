# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.dev) directly into your LLM's brain.

## Features

- **Skill Discovery** - Automatically finds skills in a configured directory
- **Server Instructions** - Injects skill metadata into the client's system prompt
- **Skill Tool** - Load full skill content on demand (progressive disclosure)

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Pass skills directory as argument
skill-jack-mcp /path/to/skills

# Or use environment variable
SKILLS_DIR=/path/to/skills skill-jack-mcp
```

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skill-jack-mcp "C:/Users/you/skills"
```

## How It Works

The server implements the Agent Skills progressive disclosure pattern:

1. **At startup**: Discovers all skills and generates `<available_skills>` XML for server instructions
2. **On connection**: Client receives skill metadata (name, description, location) in system prompt
3. **On tool call**: Agent calls `skill` tool to load full SKILL.md content

```
┌─────────────────────────────────────────────────────────┐
│ MCP Client connects                                      │
│   ↓                                                      │
│ Server returns capabilities + instructions               │
│   • instructions = <available_skills> XML block          │
│   ↓                                                      │
│ LLM sees skill metadata in system prompt                 │
│   ↓                                                      │
│ LLM calls "skill" tool with skill name                   │
│   ↓                                                      │
│ Server returns full SKILL.md content                     │
└─────────────────────────────────────────────────────────┘
```

## Tools

### `skill`

Load and activate an Agent Skill by name. Returns the full SKILL.md content.

**Input:**
```json
{
  "name": "skill-name"
}
```

**Output:** Full SKILL.md content including frontmatter and instructions.

### `skill-resource`

Read files within a skill's directory (`scripts/`, `references/`, `assets/`, `snippets/`, etc.).

This follows the Agent Skills spec's progressive disclosure pattern - resources are loaded only when needed.

**Input:**
```json
{
  "skill": "mcp-server-ts",
  "path": "snippets/tools/echo.ts"
}
```

**Output:** File content.

**List available files** (pass empty path):
```json
{
  "skill": "mcp-server-ts",
  "path": ""
}
```

**Security:** Path traversal is prevented - only files within the skill directory can be accessed.

## Security

**Skills are treated as trusted content.** This server reads and serves skill files directly to clients without sanitization. Only configure skills directories containing content you trust.

Protections in place:
- Path traversal prevention (symlink-aware)
- File size limits (10MB max)
- Directory depth limits
- Skill content is confined to configured directories

Not protected against:
- Malicious content within trusted skill directories
- Prompt injection via skill instructions (skills can influence LLM behavior by design)

## Server Instructions Format

The server generates instructions that include a usage preamble and skill metadata:

```markdown
# Skills

When a user's task matches a skill description below: 1) activate it, 2) follow its instructions completely.

<available_skills>
<skill>
<name>mcp-server-ts</name>
<description>Build TypeScript MCP servers with composable code snippets...</description>
<location>C:/path/to/mcp-server-ts/SKILL.md</location>
</skill>
</available_skills>
```

This follows [MCP server instructions best practices](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/):
- Concise, actionable guidance
- No redundancy with tool descriptions
- Focused on workflow relationships

## Skill Discovery

The server scans the provided directory for subdirectories containing a `SKILL.md` file:

```
skills/
├── skill-one/
│   └── SKILL.md     ✓ Discovered
├── skill-two/
│   ├── SKILL.md     ✓ Discovered
│   └── snippets/
└── not-a-skill/
    └── README.md    ✗ Ignored (no SKILL.md)
```

Each `SKILL.md` must have valid YAML frontmatter with `name` and `description` fields.

## Testing

```bash
# Build first
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector@latest node dist/index.js /path/to/skills
```

## Configuration for Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "skill-jack": {
      "command": "npx",
      "args": ["skill-jack-mcp", "/path/to/skills"]
    }
  }
}
```

## Related

- [Agent Skills Specification](https://agentskills.dev)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
