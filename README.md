# Skilljack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

> **Tool search / deferred tools.** By default, skilljack delivers its skill catalog via MCP **server instructions**, which arrive in the `initialize` handshake and are visible to the model even when **tool search / deferred tool loading** is enabled (the default on modern Claude Code) — so automatic skill activation works out of the box. The legacy `--catalog=tool-description` mode (not recommended — see [Catalog channel](#usage) below) delivers the catalog through the `load-skill` tool description instead, but tool-search clients defer tool descriptions out of context, so that mode needs `ENABLE_TOOL_SEARCH=false` to auto-activate.

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

```bash
# Single directory
skilljack-mcp /path/to/skills

# Multiple directories
skilljack-mcp /path/to/skills /path/to/more/skills

# GitHub repository (allowlisted via GITHUB_ALLOWED_ORGS / _USERS)
GITHUB_ALLOWED_ORGS=acme skilljack-mcp github.com/acme/skills

# Well-known publisher (allowlisted via WELL_KNOWN_ALLOWED_ORIGINS).
# Each entry's SHA-256 digest is verified against the published index.
# Every fetched URL — the index, each artifact, and any redirect target — must
# match an allowlisted origin, so if a publisher serves artifacts from a
# separate CDN origin, add that origin to the list too (comma-separated).
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/

# Using environment variable
SKILLS_DIR=/path/to/skills skilljack-mcp

# Static mode (no file watching)
skilljack-mcp --static /path/to/skills

# Serve over HTTP instead of stdio (stateless Streamable HTTP on POST /mcp)
skilljack-mcp --http=3000 /path/to/skills
# or: SKILLJACK_HTTP_PORT=3000 skilljack-mcp /path/to/skills
```

**Transports:** stdio (default) or stateless HTTP (`--http[=port]`, default `3000`, or `SKILLJACK_HTTP_PORT`). HTTP serves the core skill surface (`load-skill`, `skill-resource`, `skill://` resources, `/skill` prompts) at `POST /mcp`. Discovery-on-change works the same as stdio — file watchers and remote-source polling keep the skill state fresh, and every request (including each new client's `initialize`) reads it. Because the transport is stateless it does not *push* `listChanged`/`resources/updated` notifications: already-connected clients see changes on their next request or reconnect. The MCP-Apps configuration UI is stdio-only.

**Catalog channel:** `--catalog=<instructions|tool-description>` (or `SKILLJACK_CATALOG`) picks which single channel delivers the `<available_skills>` catalog — never both. `instructions` (default): server `instructions`, sent in the `initialize` handshake so it survives tool-search deferral; on stdio it is frozen at startup — skill changes need a restart (over HTTP, newly connecting clients always get a current catalog). `tool-description` is **not recommended** and is retained only as a legacy escape hatch (and as the control condition in the evals): the `load-skill` tool description is invisible to clients that defer MCP tool descriptions (e.g. Claude Code tool search, the modern default), so auto-activation silently breaks unless the client sets `ENABLE_TOOL_SEARCH=false`; and its one advantage — live catalog refresh via `tools/listChanged` — is a prompt-cache trap, because tool definitions sit at the top of the cached prompt prefix, so every refresh invalidates the entire cache (tools + system prompt + conversation history) and re-writes it at cache-write prices. Measured 2026-07-06 ([#78](https://github.com/olaservo/skilljack-mcp/issues/78)): it has no cost advantage over `instructions` in steady state either.

## Configuration and Skills Display UI

This server comes along with a [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)-based UI for clients that support it.  Instead of fiddling with config files or environment variables, you can just configure your skills locations and skill visiblity directly in your chat window.

(Screenshots below are from Claude Desktop in dark mode.)

![Skills Configuration UI](docs/images/skills-config-ui.png)

![Skill Display UI](docs/images/skill-display-ui.png)

## Documentation

For complete documentation, just ask your assistant:

> "how do I use skilljack?" or "how does skilljack work behind the scenes?"

This loads the [full reference](https://github.com/olaservo/skilljack-mcp/blob/main/skills/skilljack-docs/SKILL.md) including tools, prompts, resources, configuration options, and architecture details.

## Related

- [Agent Skills Specification](https://agentskills.io)
- [Skills Over MCP Interest Group repository](https://github.com/modelcontextprotocol/experimental-ext-skills)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Example MCP Clients](https://modelcontextprotocol.io/clients)
