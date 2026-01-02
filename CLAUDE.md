# Skill Jack MCP - Developer Guide

## Commands

- `npm run build` - Compile TypeScript to dist/
- `npm run dev` - Watch mode (tsx)
- `npm run inspector` - Test with MCP Inspector

## Project Structure

```
src/
├── index.ts           # Entry point, server setup, stdio transport
├── skill-discovery.ts # YAML frontmatter parsing, XML generation
├── skill-tool.ts      # MCP tools: skill, skill-resource
├── skill-resources.ts # MCP Resources: skill:// URI scheme
├── roots-handler.ts   # MCP Roots support, workspace discovery
└── subscriptions.ts   # File watching, resource subscriptions
```

## Key Abstractions

**SkillState** - Shared state for dynamic updates:
- `skillMap: Map<string, SkillMetadata>` - name → skill lookup
- `instructions: string` - Generated XML for system prompt

**SkillMetadata** - Parsed skill info:
- `name`, `description`, `path` (to SKILL.md)

## Architecture

1. **Shared state pattern**: Tools/resources reference `SkillState` object, updated when roots change
2. **Post-init discovery**: `server.server.oninitialized` triggers `syncSkills()` after client capabilities known
3. **MCP SDK patterns**: Uses `McpServer`, `ResourceTemplate`, Zod schemas for tool inputs

## Modification Guide

| To add... | Modify... |
|-----------|-----------|
| New tool | `skill-tool.ts` - use `server.registerTool()` |
| New resource | `skill-resources.ts` - use `server.registerResource()` |
| Skill discovery logic | `skill-discovery.ts` |
| Roots handling | `roots-handler.ts` |

## Conventions

- ES modules (`.js` extensions in imports)
- Errors logged to stderr (stdout is MCP protocol)
- Security: path traversal checks via `isPathWithinBase()`
- File size limit: 10MB (`MAX_FILE_SIZE`)
