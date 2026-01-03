# Skill Jack MCP - Developer Guide

## Commands

- `npm run build` - Compile TypeScript to dist/
- `npm run dev` - Watch mode (tsx)
- `npm run inspector` - Test with MCP Inspector

## Project Structure

```
src/
├── index.ts           # Entry point, server setup, file watching, stdio transport
├── skill-discovery.ts # YAML frontmatter parsing, XML generation
├── skill-tool.ts      # MCP tools: skill, skill-resource
├── skill-resources.ts # MCP Resources: skill:// URI scheme
└── subscriptions.ts   # File watching, resource subscriptions
```

## Key Abstractions

**SkillState** - Shared state:
- `skillMap: Map<string, SkillMetadata>` - name → skill lookup

**SkillMetadata** - Parsed skill info:
- `name`, `description`, `path` (to SKILL.md)

**RegisteredTool** - SDK type for dynamic tool updates:
- Returned by `registerSkillTool()`
- Has `update({ description })` method for refreshing tool description

## Architecture

1. **Startup discovery**: Skills discovered from configured directories at startup (supports multiple)
2. **File watching**: chokidar watches skill directories for SKILL.md changes
3. **Dynamic refresh**: On file change → re-discover → update tool description → send `tools/listChanged`
4. **Tool description**: Skill metadata embedded in `skill` tool description, refreshable via `tools/listChanged`
5. **Progressive disclosure**: Full SKILL.md loaded on demand via `skill` tool
6. **MCP SDK patterns**: Uses `McpServer`, `ResourceTemplate`, Zod schemas for tool inputs

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `discoverSkillsFromDirs()` | index.ts | Scan directories for skills |
| `refreshSkills()` | index.ts | Re-discover + update tool + notify clients |
| `watchSkillDirectories()` | index.ts | Set up chokidar watchers |
| `generateInstructions()` | skill-discovery.ts | Create XML skill list |
| `getToolDescription()` | skill-tool.ts | Usage text + skill list for tool desc |
| `refreshSubscriptions()` | subscriptions.ts | Update watchers when skills change |

## Modification Guide

| To add... | Modify... |
|-----------|-----------|
| New tool | `skill-tool.ts` - use `server.registerTool()` |
| New resource | `skill-resources.ts` - use `server.registerResource()` |
| Skill discovery logic | `skill-discovery.ts` |
| File watching behavior | `index.ts` - `watchSkillDirectories()` |
| Refresh logic | `index.ts` - `refreshSkills()` |

## Capabilities

```typescript
capabilities: {
  tools: { listChanged: true },      // Dynamic tool updates
  resources: { subscribe: true, listChanged: true }
}
```

## Notifications Sent

- `notifications/tools/list_changed` - When skills change (add/modify/remove)
- `notifications/resources/list_changed` - When skills change
- `notifications/resources/updated` - When subscribed resource files change

## Conventions

- ES modules (`.js` extensions in imports)
- Errors logged to stderr (stdout is MCP protocol)
- Security: path traversal checks via `isPathWithinBase()`
- File size limit: 1MB default (`MAX_FILE_SIZE_MB` env var to configure)
- Debouncing: 500ms for skill refresh, 100ms for resource notifications

## Testing

See `TEST_PLAN.md` for comprehensive test cases covering:
- Server initialization and capabilities
- Tool functionality (skill, skill-resource)
- Resource access via skill:// URIs
- Subscriptions and notifications
- Dynamic skill discovery (add/modify/remove)
- Edge cases and security
