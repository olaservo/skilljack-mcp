---
name: skilljack-docs
description: Complete documentation for the Skilljack MCP server - tools, prompts, resources, configuration, and architecture reference.
---

# Skilljack MCP Documentation

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Recommended:** For best results, use an MCP client that supports `tools/listChanged` notifications (e.g., Claude Code). This enables dynamic skill discovery - when skills are added or modified, the client automatically refreshes its understanding of available skills. Alternatively, use `--static` mode for predictable behavior with a fixed skill set.

> **Tool search / deferred tools.** By default, skilljack delivers its skill catalog via MCP **server instructions**, which arrive in the `initialize` handshake and reach the model even when **tool search / deferred tool loading** is enabled (the default on modern Claude Code, ~2.1.x) — automatic skill activation works out of the box. The legacy `--catalog=tool-description` mode (not recommended) delivers the catalog inside the `load-skill` tool description instead, but tool-search clients defer MCP tool descriptions out of context, so that mode requires disabling tool search (e.g. `ENABLE_TOOL_SEARCH=false`) for auto-activation. See [Catalog Delivery](#catalog-delivery).

## Features

- **Dynamic Skill Discovery** - Watches skill directories and automatically refreshes when skills change
- **Multiple Sources** - Local directories, GitHub repositories, and `.well-known/agent-skills/` publishers (both allowlisted)
- **Tool List Changed Notifications** - Sends `tools/listChanged` so clients can refresh available skills
- **`load-skill` Tool** - Load full skill content on demand (progressive disclosure)
- **MCP Prompts** - Load skills via `/skill` prompt with auto-completion or per-skill prompts
- **MCP Resources** - Access skills via `skill://` URIs aligned with [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
- **Resource Subscriptions** - Real-time file watching with `notifications/resources/updated`
- **Configuration UI** - Manage skill directories through an interactive UI in supported clients

## Motivation

This server demonstrates a way to approach integrating skills using existing MCP primitives.

MCP already has the building blocks:
- **Tools** for on-demand skill loading (the `load-skill` tool)
- **Server instructions** for surfacing the skill catalog at `initialize` (the default catalog channel)
- **Resources** for explicit skill access (`skill://` URIs)
- **Notifications** for real-time updates (`tools/listChanged`, `resources/updated`)
- **Prompts** for explicitly invoking skills by name (`/my-server-skill`)

This approach provides separation of concerns. Rather than every MCP server needing to embed skill handling, the server acts as a dedicated 'skill gateway'. Server authors can bundle skills alongside their MCP servers without modifying the servers themselves. If MCP registries support robust tool discovery, skill tools become discoverable like any other tool.

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

### Remote Sources

In addition to local directories, skills can be pulled from two kinds of remote sources. Both are **default-deny** — a remote source is only synced if its origin is on the corresponding allowlist.

```bash
# GitHub repository (allowlisted via GITHUB_ALLOWED_ORGS / GITHUB_ALLOWED_USERS)
GITHUB_ALLOWED_ORGS=acme skilljack-mcp github.com/acme/skills

# Well-known publisher serving /.well-known/agent-skills/index.json
# (allowlisted via WELL_KNOWN_ALLOWED_ORIGINS)
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/
```

- **GitHub** repos are cloned into a local cache and polled for updates; skills are namespaced with an `owner-repo` prefix.
- **Well-known publishers** serve a discovery index (per the [agent-skills discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc)). Every artifact is **SHA-256-verified** against the index before it is written, archives (`.tar.gz`/`.zip`) are extracted with path-traversal/symlink/size protections, and **every fetched URL — index, artifact, and any redirect target — must be on `WELL_KNOWN_ALLOWED_ORIGINS`** (so a separate CDN origin must be allowlisted too). See the [Developer Guide](https://github.com/olaservo/skilljack-mcp/blob/main/CLAUDE.md) for the full list of `WELL_KNOWN_*` tuning env vars.

Sources can be mixed freely on one command line (local dirs, GitHub URLs, and well-known URLs together).

### Static Mode

By default, Skilljack MCP watches skill directories for changes and notifies clients when skills are added, modified, or removed.

Enable **static mode** to freeze the skills list at startup:

```bash
skilljack-mcp --static /path/to/skills
# or
SKILLJACK_STATIC=true skilljack-mcp /path/to/skills
```

In static mode:
- Skills are discovered once at startup and never refreshed
- No file watchers are set up for skill directories
- `tools.listChanged` and `prompts.listChanged` capabilities are `false`
- Resource subscriptions remain fully dynamic (individual skill files can still be watched)

Use static mode when you need predictable behavior or have a fixed set of skills that won't change during the session.

**Windows note**: Use forward slashes in paths when using with MCP Inspector:
```bash
skilljack-mcp "C:/Users/you/skills"
```

### Catalog Delivery

The `<available_skills>` catalog is delivered through exactly **one** channel, selected with `--catalog=<mode>` or `SKILLJACK_CATALOG` — never both:

```bash
# Default: catalog in server instructions (survives tool search)
skilljack-mcp /path/to/skills

# Legacy escape hatch, not recommended: catalog in the load-skill tool description
skilljack-mcp --catalog=tool-description /path/to/skills
```

- **`instructions`** (default) — the catalog (plus `load-skill` usage guidance) is sent as MCP server `instructions` in the `initialize` handshake. It is visible to the model even under tool search / deferred tool loading. Trade-off: on stdio, the MCP SDK sets instructions once at construction, so the catalog is **frozen until restart** — live skill add/remove won't reach connected clients. (Over HTTP, instructions are regenerated per request from the watched skill state, so *newly connecting* clients always get a current catalog; already-connected clients receive instructions only at `initialize` and see changes after reconnecting.)
- **`tool-description`** (**not recommended** — legacy escape hatch, also used as the control condition in the evals) — the catalog lives in the `load-skill` tool description and refreshes live via `tools/listChanged` when skills change. Why it's not recommended: (1) clients with tool search enabled (the modern Claude Code default) defer MCP tool descriptions out of context, so the model never sees the catalog and auto-activation silently breaks unless the client sets `ENABLE_TOOL_SEARCH=false`; (2) its one advantage — live refresh — is a prompt-cache trap: tool definitions sit at the top of the cached prompt prefix, so every `tools/listChanged` refresh invalidates the entire prompt cache (tools + system prompt + conversation history) and re-writes it at cache-write prices; (3) measured 2026-07-06 ([issue #78](https://github.com/olaservo/skilljack-mcp/issues/78)), it has no steady-state cost advantage over `instructions` either.

### HTTP Transport

By default skilljack communicates over **stdio**. To serve over **stateless Streamable HTTP** instead, use `--http` (or `SKILLJACK_HTTP_PORT`):

```bash
skilljack-mcp --http=3000 /path/to/skills
```

Clients connect at `POST /mcp`. HTTP mode serves the core skill surface — `load-skill`, `skill-resource`, `skill://` resources, and `/skill` prompts. Discovery-on-change works the same as stdio: file watchers and remote-source polling keep the skill state fresh, and every request reads it — so newly connecting clients get a current catalog, and `load-skill`/`tools/list` reflect changes immediately. Because the transport is stateless (no session, no server→client stream), it does **not** *push* `listChanged` / `resources/updated` notifications — already-connected clients see changes on their next request (for the instructions catalog, on their next reconnect). The UI config/display tools are stdio-only.

## Configuration UI

In MCP clients that support [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (like Claude Desktop), you can manage skill directories through an interactive UI.

**To open the configuration UI**, ask your assistant to show the skilljack config:

> "show me the skilljack config"

The UI displays:
- Current skill directories with skill counts
- Status indicators showing which directories are from config vs command-line
- Options to add new directories or remove existing ones

Changes made through the UI are persisted to the server's configuration. Clients that support `tools/listChanged` notifications will see updates immediately; others may require reconnection.

## Skill Display UI

View all available skills and customize their invocation settings through the skill display UI.

**To open the skill display UI**, ask your assistant:

> "what skills are configured in skilljack?"

The UI displays:
- All discovered skills with name, description, and file path
- **Source indicators** showing whether each skill is from a local directory, a GitHub repository, or a well-known publisher
- **Invocation toggles** to enable/disable Assistant (model auto-invoke) and User (prompts menu) visibility
- **Customized badge** when settings differ from frontmatter defaults

Skills from GitHub repositories show the org/repo name (e.g., `modelcontextprotocol/ext-apps`), and well-known skills show the publisher origin, making it easy to identify where each skill originates.

## How It Works

The server implements the [Agent Skills](https://agentskills.io) progressive disclosure pattern with dynamic updates:

1. **At startup**: Discovers skills from configured directories and starts file watchers
2. **On connection**: the skill catalog is delivered via server instructions (default) or the `load-skill` tool description (`--catalog=tool-description`)
3. **On file change**: Re-discovers skills, updates the tool description and prompts, sends `tools/listChanged` (in tool-description mode this refreshes the catalog; in instructions mode the catalog is frozen until restart on stdio)
4. **On tool call**: Agent calls `load-skill` tool to load full SKILL.md content
5. **As needed**: Agent calls `skill-resource` to load additional files

```
┌─────────────────────────────────────────────────────────┐
│ Server starts                                            │
│   • Discovers skills from configured directories         │
│   • Starts watching for SKILL.md changes                 │
│   ↓                                                      │
│ MCP Client connects                                      │
│   • Skill catalog delivered via server instructions      │
│     (default) or load-skill tool description             │
│   • Prompts registered for each skill                    │
│   ↓                                                      │
│ LLM sees skill metadata in the catalog                   │
│   ↓                                                      │
│ SKILL.md added/modified/removed                          │
│   • Server re-discovers skills                           │
│   • Updates load-skill tool description                  │
│   • Updates prompt list (add/remove/modify)              │
│   • Sends tools/listChanged notification                 │
│   • Sends prompts/listChanged notification               │
│   • Client refreshes tool and prompt definitions         │
│   ↓                                                      │
│ User invokes /skill prompt or /skill-name prompt         │
│   OR LLM calls "load-skill" tool with skill name         │
│   ↓                                                      │
│ Server returns full SKILL.md content                     │
│   ↓                                                      │
│ LLM calls "skill-resource" for additional files          │
│   • Scripts, snippets, references, assets, etc.          │
└─────────────────────────────────────────────────────────┘
```

## Tools vs Resources vs Prompts

This server exposes skills via **tools**, **resources**, and **prompts**:

- **Tools** (`load-skill`, `skill-resource`) - For your agent to use autonomously. The LLM sees available skills in the skill catalog (server instructions by default, or the `load-skill` tool description) and calls them as needed.
- **Prompts** (`/skill`, `/skill-name`) - For explicit user invocation. Use `/skill` with auto-completion or select a skill directly by name.
- **Resources** (`skill://` URIs) - For manual selection in apps that support it (e.g., Claude Desktop's resource picker). Useful when you want to explicitly attach a skill to the conversation.

Skills are context delivered through MCP primitives. Tools enable autonomous activation by the agent. Prompts enable user-initiated loading with auto-completion. Resources provide explicit access for manual control. Each mechanism suits different workflows — skills aren't tied to any single delivery path.

## Progressive Disclosure Design

This server implements the [Agent Skills progressive disclosure pattern](https://agentskills.io/specification#progressive-disclosure), which structures skills for efficient context usage:

| Level | Tokens | What's loaded | When |
|-------|--------|---------------|------|
| **Metadata** | ~100 | `name` and `description` | At startup, for all skills |
| **Instructions** | < 5000 | Full SKILL.md body | When skill is activated |
| **Resources** | As needed | Files in `scripts/`, `references/`, `assets/` | On demand via `skill-resource` |

### How it works

1. **Discovery** - Server loads metadata from all skills into the skill catalog (server instructions by default, or the `load-skill` tool description)
2. **Activation** - When a skill is loaded (via tool, prompt, or resource), only the SKILL.md content is returned
3. **Execution** - SKILL.md references additional files; agent fetches them with `skill-resource` as needed

### Why SKILL.md documents its own resources

The skill catalog and the loaded SKILL.md body don't enumerate every file in a skill directory. Instead, skill authors document available resources directly in their SKILL.md (e.g., "Copy the template from `templates/server.ts`"). This design choice follows the spec because:

- **Skill authors know best** - They decide which files are relevant and when to use them
- **Context efficiency** - Loading everything upfront wastes tokens on files the agent may not need
- **Natural flow** - SKILL.md guides the agent through resources in a logical order

(Supporting files *are* enumerated in `resources/list` for clients that browse resources — see [Resources](#resources) — but at lower priority than `SKILL.md`, and the progressive-disclosure tool/prompt path above still loads only what the SKILL.md points to.)

**For skill authors:** Reference files using relative paths from the skill root (e.g., `snippets/tool.ts`, `references/api.md`). Keep your main SKILL.md under 500 lines; move detailed reference material to separate files. See the [Agent Skills specification](https://agentskills.io/specification) for complete authoring guidelines.

## Tools

### `load-skill`

Load and activate an Agent Skill by name. Returns the full SKILL.md content.

> Named `load-skill` (not `skill`) to avoid colliding with clients that ship a built-in `Skill` tool (e.g. Claude Code); a distinct verb-first name removes the routing ambiguity. The user-facing *prompt* is still `/skill`.

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

Skills are also accessible via MCP [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resources) using `skill://` URIs, following the [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) convention. The server advertises support via the `extensions["io.modelcontextprotocol/skills"]` capability key in its `initialize` response.

### URI Patterns

| URI | Returns |
|-----|---------|
| `skill://<skill-path>/SKILL.md` | The skill's `SKILL.md` (`text/markdown`). Listed in `resources/list`. |
| `skill://<skill-path>/<file-path>` | A supporting file inside the skill directory. Listed in `resources/list` at lower priority than `SKILL.md`. |
| `skill://index.json` | SEP-2640 discovery index (`application/json`). Listed in `resources/list`. |

`<skill-path>` is `<prefix>/<baseName>` for prefixed skills (the prefix segments come from the skill's source — e.g., a local directory basename or `owner-repo` for GitHub-sourced skills) or just `<baseName>` for bundled skills. The final `<skill-path>` segment always matches the `name` field in the skill's frontmatter, per SEP.

### Resource Subscriptions

Clients can subscribe to resources for real-time updates when files change.

**Capability:** `resources: { subscribe: true, listChanged: true }`

**Subscribe to a resource:**
```
→ resources/subscribe { uri: "skill://skilljack-docs/SKILL.md" }
← {} (success)
```

**Receive notifications when files change:**
```
← notifications/resources/updated { uri: "skill://skilljack-docs/SKILL.md" }
```

**Unsubscribe:**
```
→ resources/unsubscribe { uri: "skill://skilljack-docs/SKILL.md" }
← {} (success)
```

Subscribing to `skill://index.json` watches every SKILL.md, so any skill change re-fires that subscription as well as `notifications/resources/updated` for `skill://index.json` directly when skills are added or removed.

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
2. The `load-skill` tool's description is updated with current skill names and metadata (in `--catalog=tool-description` mode; in the default instructions mode the catalog itself is frozen until restart on stdio)
3. Per-skill prompts are added, removed, or updated accordingly
4. `tools/listChanged` and `prompts/listChanged` notifications are sent to connected clients
5. Clients that support these notifications will refresh tool and prompt definitions

## Skill Metadata Format

The skill catalog (server instructions by default, or the `load-skill` tool description in `--catalog=tool-description` mode) includes metadata for all available skills in XML format:

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

In tool-description mode this metadata is dynamically updated when skills change — clients supporting `tools/listChanged` will automatically refresh. In the default instructions mode it is generated at startup (stdio) or per request (HTTP).

## Skill Discovery

Skills are discovered at startup from the configured directories. For each directory, the server checks:
- The directory itself for skill subdirectories
- `.claude/skills/` subdirectory
- `skills/` subdirectory

Each skill subdirectory must contain a `SKILL.md` file with YAML frontmatter including `name` and `description` fields.

## Skill Visibility Control

Control which skills appear in tools vs prompts using optional frontmatter fields:

| Frontmatter | In Skill Catalog | In Prompts Menu | Use Case |
|-------------|---------------------|-----------------|----------|
| (default) | Yes | Yes | Normal skills |
| `disable-model-invocation: true` | No | Yes | User-triggered workflows (deploy, commit) |
| `user-invocable: false` | Yes | No | Background context (model auto-loads when relevant) |

### Example: User-Only Skill

Hide from model auto-discovery, require explicit user invocation via `/skill-name` prompt:

```yaml
---
name: deploy
description: Deploy to production
disable-model-invocation: true
---
```

### Example: Model-Only Skill

Hide from prompts menu, model uses automatically when relevant:

```yaml
---
name: codebase-context
description: Background information about this codebase
user-invocable: false
---
```

Note: Resources (`skill://` URIs) always include all skills regardless of visibility settings, allowing explicit access when needed.

## Testing

### Manual Testing with MCP Inspector

```bash
npm run build
npm run inspector -- /path/to/skills
```

### Automated Evals (Development Only)

The `evals/` directory contains an evaluation framework for testing skill activation across different delivery modes. Evals are only available when developing from source (not included in the npm package).

```bash
# Clone the repo first
git clone https://github.com/olaservo/skilljack-mcp.git
cd skilljack-mcp

# Install dev dependencies (includes claude-agent-sdk for evals)
npm install

# Build and run evals
npm run build
npm run eval                              # Default: greeting task, MCP mode
npm run eval -- --task=xlsx-openpyxl      # Specific task
npm run eval -- --mode=local              # Local skill mode
npm run eval -- --mode=mcp+local          # Both MCP and local enabled
```

See [evals/README.md](https://github.com/olaservo/skilljack-mcp/blob/main/evals/README.md) for details on available tasks, modes, and findings about activation behavior differences.

## Related

- [Agent Skills Specification](https://agentskills.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
