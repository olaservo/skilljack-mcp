# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Recommended:** For best results, use an [MCP client](https://modelcontextprotocol.io/clients) that supports server instructions. This allows the LLM to see available skills in its system prompt, enabling automatic skill discovery and activation. Without this support, the model will still be able to call these tools, but you might need to provide more explicit instructions on what skills are available and the intended activation patterns.

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

Configure one or more skills directories containing your Agent Skills:

```bash
# Single directory
skill-jack-mcp /path/to/skills

# Multiple directories (separate args or comma-separated)
skill-jack-mcp /path/to/skills /path/to/more/skills
skill-jack-mcp /path/to/skills,/path/to/more/skills

# Using environment variable (comma-separated for multiple)
SKILLS_DIR=/path/to/skills skill-jack-mcp
SKILLS_DIR=/path/to/skills,/path/to/more/skills skill-jack-mcp
```

Each directory is scanned along with its `.claude/skills/` and `skills/` subdirectories for skills. Duplicate skill names are handled by keeping the first occurrence.

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skill-jack-mcp "C:/Users/you/skills"
```

## How It Works

The server implements the [Agent Skills](https://agentskills.io) progressive disclosure pattern:

1. **At startup**: Discovers skills from configured directories
2. **On connection**: Server instructions (with skill metadata) are sent in the initialize response
3. **On tool call**: Agent calls `skill` tool to load full SKILL.md content
4. **As needed**: Agent calls `skill-resource` to load additional files (scripts, snippets, references, etc.)

```
┌─────────────────────────────────────────────────────────┐
│ Server starts                                            │
│   • Discovers skills from configured directories         │
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
│   ↓                                                      │
│ LLM calls "skill-resource" for additional files          │
│   • Scripts, snippets, references, assets, etc.          │
│   • Loaded on-demand as the skill instructions direct    │
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

**Read a single file:**
```json
{
  "skill": "mcp-server-ts",
  "path": "snippets/tools/echo.ts"
}
```

**Read all files in a directory:**
```json
{
  "skill": "algorithmic-art",
  "path": "templates"
}
```
Returns all files in the directory as multiple content items.

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

Skills are discovered at startup from the configured directories. For each directory, the server checks:
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

- [Agent Skills Specification](https://agentskills.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
