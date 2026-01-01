# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.dev) directly into your LLM's brain.

## Features

- **Dynamic Skill Discovery** - Discovers skills from MCP Roots (client workspace) or fallback directory
- **Server Instructions** - Injects skill metadata into the client's system prompt
- **Skill Tool** - Load full skill content on demand (progressive disclosure)
- **MCP Resources** - Access skills via `skill://` URIs with batch collection support
- **Resource Subscriptions** - Real-time file watching with `notifications/resources/updated`
- **Live Updates** - Re-discovers skills when workspace roots change

## Installation

```bash
npm install
npm run build
```

## Usage

### With MCP Roots (Recommended)

If your [MCP client supports Roots](https://modelcontextprotocol.io/clients), skills are discovered automatically from your workspace:

```bash
# No arguments needed - discovers from client workspace
skill-jack-mcp
```

The server scans `.claude/skills/` and `skills/` directories in each workspace root.

### With Fallback Directory

For clients without Roots support, or to provide a default skills location:

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

The server implements the Agent Skills progressive disclosure pattern with MCP Roots support:

1. **On connection**: Server requests workspace roots from client (or uses fallback directory)
2. **Discovery**: Scans roots for `.claude/skills/` and `skills/` directories
3. **Instructions**: Generates `<available_skills>` XML with discovered skill metadata
4. **On tool call**: Agent calls `skill` tool to load full SKILL.md content
5. **Live updates**: Re-discovers when client's workspace roots change

```
┌─────────────────────────────────────────────────────────┐
│ MCP Client connects                                      │
│   ↓                                                      │
│ Server requests roots from client                        │
│   • Scans .claude/skills/ and skills/ in each root      │
│   • Falls back to SKILLS_DIR if roots not supported      │
│   ↓                                                      │
│ LLM sees skill metadata in system prompt                 │
│   ↓                                                      │
│ LLM calls "skill" tool with skill name                   │
│   ↓                                                      │
│ Server returns full SKILL.md content                     │
│   ↓                                                      │
│ (Workspace changes → roots/list_changed → re-discover)   │
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

Skills are also accessible via MCP Resources using `skill://` URIs.

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

**URI to file path resolution:**
- `skill://` → watches all skill directories
- `skill://{name}` → watches that skill's SKILL.md
- `skill://{name}/{path}` → watches specific file

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

## Skill Discovery

### From MCP Roots

When the client supports roots, the server scans each workspace root for:
- `{root}/.claude/skills/`
- `{root}/skills/`

### From Fallback Directory

When roots aren't available, the server scans the configured directory.

### Naming Conflicts

If the same skill name exists in multiple roots, it's prefixed with the root name (e.g., `project-a:commit`).

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
