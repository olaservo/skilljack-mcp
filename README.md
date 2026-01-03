# Skill Jack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Recommended:** For best results, use an MCP client that supports `tools/listChanged` notifications (e.g., Claude Code). This enables dynamic skill discovery - when skills are added or modified, the client automatically refreshes its understanding of available skills.

## Features

- **Dynamic Skill Discovery** - Watches skill directories and automatically refreshes when skills change
- **Tool List Changed Notifications** - Sends `tools/listChanged` so clients can refresh available skills
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

The server implements the [Agent Skills](https://agentskills.io) progressive disclosure pattern with dynamic updates:

1. **At startup**: Discovers skills from configured directories and starts file watchers
2. **On connection**: Skill tool description includes available skills metadata
3. **On file change**: Re-discovers skills, updates tool description, sends `tools/listChanged`
4. **On tool call**: Agent calls `skill` tool to load full SKILL.md content
5. **As needed**: Agent calls `skill-resource` to load additional files

```
┌─────────────────────────────────────────────────────────┐
│ Server starts                                            │
│   • Discovers skills from configured directories         │
│   • Starts watching for SKILL.md changes                 │
│   ↓                                                      │
│ MCP Client connects                                      │
│   • Skill tool description includes available skills     │
│   ↓                                                      │
│ LLM sees skill metadata in tool description              │
│   ↓                                                      │
│ SKILL.md added/modified/removed                          │
│   • Server re-discovers skills                           │
│   • Updates skill tool description                       │
│   • Sends tools/listChanged notification                 │
│   • Client refreshes tool definitions                    │
│   ↓                                                      │
│ LLM calls "skill" tool with skill name                   │
│   ↓                                                      │
│ Server returns full SKILL.md content                     │
│   ↓                                                      │
│ LLM calls "skill-resource" for additional files          │
│   • Scripts, snippets, references, assets, etc.          │
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
- File size limits (1MB default, configurable via `MAX_FILE_SIZE_MB` env var)
- Directory depth limits
- Skill content is confined to configured directories

Not protected against:
- Malicious content within trusted skill directories
- Prompt injection via skill instructions (skills can influence LLM behavior by design)

## Dynamic Skill Discovery

The server watches skill directories for changes. When SKILL.md files are added, modified, or removed:

1. Skills are re-discovered from all configured directories
2. The `skill` tool's description is updated with current skill names and metadata
3. `tools/listChanged` notification is sent to connected clients
4. Clients that support this notification will refresh tool definitions

## Skill Metadata Format

The `skill` tool description includes metadata for all available skills in XML format:

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

This metadata is dynamically updated when skills change - clients supporting `tools/listChanged` will automatically refresh.

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
