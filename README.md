# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.dev) directly into your LLM's brain.

## Features

- **Skill Discovery** - Discovers skills from a configured directory at startup
- **Server Instructions** - Injects skill metadata into the system prompt (for clients supporting instructions)
- **Skill Tool** - Load full skill content on demand (progressive disclosure)
- **MCP Resources** - Access skills via `skill://` URIs with batch collection support
- **Resource Subscriptions** - Real-time file watching with `notifications/resources/updated`

## Installation

```bash
npm install @olaservo/skill-jack-mcp
```

Or run directly with npx:

```bash
npx @olaservo/skill-jack-mcp /path/to/skills
```

### From Source

```bash
git clone https://github.com/olaservo/skill-jack-mcp.git
cd skill-jack-mcp
npm install
npm run build
```

## Usage

Configure a skills directory containing your Agent Skills:

```bash
# Pass skills directory as argument
skill-jack-mcp /path/to/skills

# Or use environment variable
SKILLS_DIR=/path/to/skills skill-jack-mcp
```

The server scans the directory and its `.claude/skills/` and `skills/` subdirectories for skills.

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skill-jack-mcp "C:/Users/you/skills"
```

## How It Works

The server implements the [Agent Skills](https://agentskills.dev) progressive disclosure pattern:

1. **At startup**: Discovers skills from configured directory
2. **On connection**: Server instructions (with skill metadata) are sent in the initialize response
3. **On tool call**: Agent calls `skill` tool to load full SKILL.md content

```
┌─────────────────────────────────────────────────────────┐
│ Server starts                                            │
│   • Discovers skills from configured directory           │
│   • Generates instructions with skill metadata           │
│   ↓                                                      │
│ MCP Client connects                                      │
│   • Server instructions included in initialize response  │
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

## Resources

Skills are also accessible via MCP [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resources) using `skill://` URIs.

### URI Patterns

| URI | Returns |
|-----|---------|
| `skill://` | All SKILL.md contents (collection) |
| `skill://{name}` | Single skill's SKILL.md content |
| `skill://{name}/` | All files in skill directory (collection) |
| `skill://{name}/{path}` | Specific file within skill |

### Resource Subscriptions

Clients can subscribe to resources for real-time updates when files change.

**Capability:** `resources: { subscribe: true, listChanged: true }`

**Subscribe to a resource:**
```
→ resources/subscribe { uri: "skill://mcp-server-ts" }
← {} (success)
```

**Receive notifications when files change:**
```
← notifications/resources/updated { uri: "skill://mcp-server-ts" }
```

**Unsubscribe:**
```
→ resources/unsubscribe { uri: "skill://mcp-server-ts" }
← {} (success)
```

**How it works:**
1. Client subscribes to a `skill://` URI
2. Server resolves URI to file path(s) and starts watching with chokidar
3. When files change, server debounces (100ms) and sends notification
4. Client can re-read the resource to get updated content

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

The server generates [instructions](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/) that include a usage preamble and skill metadata:

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

These are loaded into the model's system prompt by [clients](https://modelcontextprotocol.io/clients) that support instructions.

## Skill Discovery

Skills are discovered at startup from the configured directory. The server checks:
- The directory itself for skill subdirectories
- `.claude/skills/` subdirectory
- `skills/` subdirectory

Each skill subdirectory must contain a `SKILL.md` file with YAML frontmatter including `name` and `description` fields.

## Testing

```bash
# Build first
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector@latest node dist/index.js /path/to/skills
```

## Related

- [Agent Skills Specification](https://agentskills.dev)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
