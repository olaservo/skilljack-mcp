# Skilljack MCP

An MCP server that jacks [Agent Skills](https://agentskills.io) directly into your LLM's brain.

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
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/

# Using environment variable
SKILLS_DIR=/path/to/skills skilljack-mcp

# Static mode (no file watching)
skilljack-mcp --static /path/to/skills
```

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
