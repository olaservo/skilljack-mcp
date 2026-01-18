# Skilljack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Recommended:** For best results, use an MCP client that supports `tools/listChanged` notifications (e.g., Claude Code). This enables dynamic skill discovery - when skills are added or modified, the client automatically refreshes its understanding of available skills.

## Features

- **Dynamic Skill Discovery** - Watches skill directories and automatically refreshes when skills change
- **Tool List Changed Notifications** - Sends `tools/listChanged` so clients can refresh available skills
- **Skill Tool** - Load full skill content on demand (progressive disclosure)
- **MCP Prompts** - Load skills via `/skill` prompt with auto-completion or per-skill prompts
- **MCP Resources** - Access skills via `skill://` URIs with batch collection support
- **Resource Subscriptions** - Real-time file watching with `notifications/resources/updated`

## Motivation

This repo demonstrates a way to approach integrating skills using existing MCP primitives.

MCP already has the building blocks:
- **Tools** for on-demand skill loading (the `skill` tool with dynamically updated descriptions)
- **Resources** for explicit skill access (`skill://` URIs)
- **Notifications** for real-time updates (`tools/listChanged`, `resources/updated`)
- **Prompts** for explicitly invoking skills by name (`/my-server-skill`)

This approach provides separation of concerns.  Rather than every MCP server needing to embed skill handling, the server acts as a dedicated 'skill gateway'. Server authors can bundle skills alongside their MCP servers without modifying the servers themselves. If MCP registries support robust tool discovery, skill tools become discoverable like any other tool.

## Installation

```bash
npm install @skilljack/mcp
```

Or run directly with npx:

```bash
npx @skilljack/mcp /path/to/skills
```

### From Source

```bash
git clone https://github.com/olaservo/skilljack-mcp.git
cd skilljack-mcp
npm install
npm run build
```

## Usage

Configure one or more skills directories containing your Agent Skills:

```bash
# Single directory
skilljack-mcp /path/to/skills

# Multiple directories (separate args or comma-separated)
skilljack-mcp /path/to/skills /path/to/more/skills
skilljack-mcp /path/to/skills,/path/to/more/skills

# Using environment variable (comma-separated for multiple)
SKILLS_DIR=/path/to/skills skilljack-mcp
SKILLS_DIR=/path/to/skills,/path/to/more/skills skilljack-mcp
```

Each directory is scanned along with its `.claude/skills/` and `skills/` subdirectories for skills. Duplicate skill names are handled by keeping the first occurrence.

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skilljack-mcp "C:/Users/you/skills"
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
│   • Prompts registered for each skill                    │
│   ↓                                                      │
│ LLM sees skill metadata in tool description              │
│   ↓                                                      │
│ SKILL.md added/modified/removed                          │
│   • Server re-discovers skills                           │
│   • Updates skill tool description                       │
│   • Updates prompt list (add/remove/modify)              │
│   • Sends tools/listChanged notification                 │
│   • Sends prompts/listChanged notification               │
│   • Client refreshes tool and prompt definitions         │
│   ↓                                                      │
│ User invokes /skill prompt or /skill-name prompt         │
│   OR LLM calls "skill" tool with skill name              │
│   ↓                                                      │
│ Server returns full SKILL.md content                     │
│   ↓                                                      │
│ LLM calls "skill-resource" for additional files          │
│   • Scripts, snippets, references, assets, etc.          │
└─────────────────────────────────────────────────────────┘
```

## Tools vs Resources vs Prompts

This server exposes skills via **tools**, **resources**, and **prompts**:

- **Tools** (`skill`, `skill-resource`) - For your agent to use autonomously. The LLM sees available skills in the tool description and calls them as needed.
- **Prompts** (`/skill`, `/skill-name`) - For explicit user invocation. Use `/skill` with auto-completion or select a skill directly by name.
- **Resources** (`skill://` URIs) - For manual selection in apps that support it (e.g., Claude Desktop's resource picker). Useful when you want to explicitly attach a skill to the conversation.

Most users will rely on tools for automatic skill activation. Prompts provide user-initiated loading with auto-completion. Resources provide an alternative for manual control.

## Progressive Disclosure Design

This server implements the [Agent Skills progressive disclosure pattern](https://agentskills.io/specification#progressive-disclosure), which structures skills for efficient context usage:

| Level | Tokens | What's loaded | When |
|-------|--------|---------------|------|
| **Metadata** | ~100 | `name` and `description` | At startup, for all skills |
| **Instructions** | < 5000 | Full SKILL.md body | When skill is activated |
| **Resources** | As needed | Files in `scripts/`, `references/`, `assets/` | On demand via `skill-resource` |

### How it works

1. **Discovery** - Server loads metadata from all skills into the `skill` tool description
2. **Activation** - When a skill is loaded (via tool, prompt, or resource), only the SKILL.md content is returned
3. **Execution** - SKILL.md references additional files; agent fetches them with `skill-resource` as needed

### Why SKILL.md documents its own resources

The server doesn't automatically list all files in a skill directory. Instead, skill authors document available resources directly in their SKILL.md (e.g., "Copy the template from `templates/server.ts`"). This design choice follows the spec because:

- **Skill authors know best** - They decide which files are relevant and when to use them
- **Context efficiency** - Loading everything upfront wastes tokens on files the agent may not need
- **Natural flow** - SKILL.md guides the agent through resources in a logical order

**For skill authors:** Reference files using relative paths from the skill root (e.g., `snippets/tool.ts`, `references/api.md`). Keep your main SKILL.md under 500 lines; move detailed reference material to separate files. See the [Agent Skills specification](https://agentskills.io/specification) for complete authoring guidelines.

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

## Prompts

Skills can be loaded via MCP [Prompts](https://modelcontextprotocol.io/specification/2025-11-05/server/prompts) for explicit user invocation.

### `/skill` Prompt

Load a skill by name with auto-completion support.

**Arguments:**
- `name` (string, required) - Skill name with auto-completion

The prompt description includes all available skills for discoverability. As you type the skill name, matching skills are suggested.

### Per-Skill Prompts

Each discovered skill is also registered as its own prompt (e.g., `/mcp-server-ts`, `/algorithmic-art`).

- No arguments needed - just select and invoke
- Description shows the skill's own description
- List updates dynamically as skills change

**Example:** If you have a skill named `mcp-server-ts`, you can invoke it directly as `/mcp-server-ts`.

### Content Annotations

Prompt responses include MCP [content annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#embedded-resources) for proper handling:

- `audience: ["assistant"]` - Content is intended for the LLM, not the user
- `priority: 1.0` - High priority content that should be included in context

Prompts return embedded resources with the skill's `skill://` URI, allowing clients to track the content source.

## Resources

Skills are also accessible via MCP [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resources) using `skill://` URIs.

### URI Patterns

| URI | Returns |
|-----|---------|
| `skill://{name}` | Single skill's SKILL.md content |
| `skill://{name}/` | All files in skill directory (collection) |

Individual file URIs (`skill://{name}/{path}`) are not listed as resources to reduce noise. Use the `skill-resource` tool to fetch specific files on demand.

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
3. Per-skill prompts are added, removed, or updated accordingly
4. `tools/listChanged` and `prompts/listChanged` notifications are sent to connected clients
5. Clients that support these notifications will refresh tool and prompt definitions

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
