# Skilljack MCP - Developer Guide

## Commands

- `npm run build` - Compile TypeScript to dist/ (Vite UI build + `tsc`)
- `npm run dev` - Watch mode (tsx)
- `npm test` - Run the vitest suite
- `npm run inspector` - Test with MCP Inspector

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build`, and `npm test` on Node 20 for every push to `main` and every PR.

## Configuration

**Environment Variables:**
- `SKILLS_DIR` - Comma-separated list of skill directories
- `SKILLJACK_STATIC` - Set to `true`, `1`, or `yes` to enable static mode
- `MAX_FILE_SIZE_MB` - Maximum file size for skill resources (default: 1MB)
- `WELL_KNOWN_ALLOWED_ORIGINS` - Comma-separated origins (e.g. `https://example.com`) permitted as well-known publishers. Default-deny.
- `WELL_KNOWN_POLL_INTERVAL_MS` - Well-known poll cadence (default 300000, `0` disables)
- `WELL_KNOWN_MAX_ARTIFACT_MB` - Per-artifact byte cap (default 10)
- `WELL_KNOWN_MAX_UNPACKED_MB` - Archive uncompressed size cap (default 50)
- `WELL_KNOWN_ALLOW_HTTP` - `1`/`true`/`yes` to permit `http://` origins (dev only)
- `SKILLJACK_HTTP_PORT` / `SKILLJACK_HTTP` - Serve over stateless HTTP instead of stdio (port, default 3000)
- `SKILLJACK_CATALOG` - Catalog delivery channel: `instructions` (default) | `tool-description` (legacy, not recommended) — exactly one, never both

**CLI Options:**
- Positional args: Skill directories, GitHub URLs, or well-known publisher URLs (e.g. `https://example.com/.well-known/agent-skills/`)
- `--static`: Enable static mode (freeze skills at startup, no file watching)
- `--http` / `--http=<port>`: Serve over stateless Streamable HTTP at `POST /mcp` instead of stdio (single token so it isn't parsed as a skill dir)
- `--catalog=<instructions|tool-description>`: Which single channel carries the `<available_skills>` catalog (never both). `instructions` (default): server `instructions` — survives tool search, but frozen at startup on stdio since the SDK can't update instructions. `tool-description` (legacy, **not recommended** — see Conventions): the `load-skill` tool description — dynamic via `tools/listChanged`, but deferred out of context by tool search, and each refresh invalidates the whole prompt cache. Kept as an escape hatch and as the evals' control condition. Env: `SKILLJACK_CATALOG`. See `getCatalogMode()` in index.ts / `CatalogMode` in skill-tool.ts.

## Project Structure

```
src/
├── index.ts               # Entry point, server setup, file watching, stdio transport
├── skill-discovery.ts     # YAML frontmatter parsing, XML generation
├── skill-tool.ts          # MCP tools: load-skill, skill-resource
├── skill-prompts.ts       # MCP Prompts: /skill with auto-completion, per-skill prompts
├── skill-resources.ts     # MCP Resources: SEP-2640 skill:// URI scheme + skill://index.json
├── subscriptions.ts       # File watching, resource subscriptions
├── skill-config.ts        # Directory/override config (~/.skilljack/config.json)
├── skill-config-tool.ts   # MCP tools backing the config UI (skill-config-*)
├── skill-display-tool.ts  # MCP tools backing the skills display UI (skill-display-*)
├── github-config.ts       # GitHub URL detection, parsing, allowlist
├── github-sync.ts         # Clone/pull GitHub repos into the cache
├── github-polling.ts      # Periodic GitHub update checks
├── well-known-config.ts   # Well-known URL detection, parsing, allowlist, URL validation
├── well-known-sync.ts     # Fetch + verify (SHA-256) + safely extract publisher artifacts
├── well-known-polling.ts  # Periodic well-known index re-fetch (ETag/If-None-Match)
├── http-transport.ts      # Stateless Streamable HTTP transport (buildCoreServer, startHttpServer)
├── types/                 # Ambient type declarations (e.g. yauzl-promise)
└── ui/                    # MCP Apps UI (mcp-app.ts, skill-display.ts) built by Vite
```

Packaging: `manifest.json` + `.mcpbignore` define the `.mcpb` bundle (MCP Bundle) for distribution.

## Key Abstractions

**SkillSource** - Origin info with namespace prefix:
- `prefix: string` - Namespace prefix (local: dir basename, GitHub: `owner-repo`, well-known: `<host-slug>[_<base-path-slug>]`, bundled: `""`)
- `type: "local" | "github" | "bundled" | "well-known"` - Which source pulled the skill

**SkillState** - Shared state:
- `skillMap: Map<string, SkillMetadata>` - qualified name → skill lookup

**SkillMetadata** - Parsed skill info:
- `name` (qualified, e.g., `my-project__commit`), `baseName` (original from frontmatter), `description`, `path` (to SKILL.md)

**RegisteredTool** - SDK type for dynamic tool updates:
- Returned by `registerSkillTool()`
- Has `update({ description })` method for refreshing tool description

**PromptRegistry** - Tracks registered prompts for updates:
- `skillPrompt: RegisteredPrompt` - The `/skill` prompt with auto-completion
- `perSkillPrompts: Map<string, RegisteredPrompt>` - Per-skill prompts (e.g., `/my-project__mcp-server-ts`)

## Architecture

1. **Startup discovery**: Skills discovered from configured directories at startup (supports multiple)
2. **File watching**: chokidar watches skill directories for SKILL.md changes
3. **Dynamic refresh**: On file change → re-discover → update tool/prompts → send notifications
4. **Catalog delivery**: `<available_skills>` catalog in server `instructions` (default; sent at `initialize`, frozen until restart on stdio) or in the `load-skill` tool description (`--catalog=tool-description`; refreshable via `tools/listChanged` but legacy/not recommended) — exactly one channel, never both
5. **Prompts**: `/skill` prompt with auto-completion + per-skill prompts, refreshable via `prompts/listChanged`
6. **Progressive disclosure**: Full SKILL.md loaded on demand via `load-skill` tool or prompts
7. **MCP SDK patterns**: Uses `McpServer`, `ResourceTemplate`, `completable()`, Zod schemas

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getStaticMode()` | index.ts | Check if static mode is enabled (CLI/env) |
| `getCatalogMode()` | index.ts | Resolve the catalog channel (`--catalog=` / `SKILLJACK_CATALOG`, default `instructions`) |
| `discoverSkillsFromDirs()` | index.ts | Scan directories for skills |
| `refreshSkills()` | index.ts | Re-discover + update tool/prompts + notify clients |
| `watchSkillDirectories()` | index.ts | Set up chokidar watchers (skipped in static mode) |
| `sanitizePrefix()` | skill-discovery.ts | Clean prefix strings for qualified names |
| `getSkillPath()` | skill-discovery.ts | Compute SEP-2640 `<skill-path>` (`<prefix>/<baseName>` or just `<baseName>`) |
| `buildSkillResourceUri()` | skill-discovery.ts | Build a `skill://<skill-path>/<file>` URI |
| `parseSkillResourceUri()` | skill-discovery.ts | Resolve a `skill://` URI back to a skill + file relpath |
| `buildSkillIndex()` | skill-discovery.ts | Build the JSON document served at `skill://index.json` |
| `generateInstructions()` | skill-discovery.ts | Create XML skill list |
| `getToolDescription()` | skill-tool.ts | Tool desc: usage text (+ skill list in tool-description mode) |
| `getServerInstructions()` | skill-tool.ts | Server `instructions` for a catalog mode (undefined in tool-description mode) |
| `getCatalogInstructions()` | skill-tool.ts | Usage preamble + skill list for instructions mode |
| `registerSkillPrompts()` | skill-prompts.ts | Register /skill + per-skill prompts |
| `refreshPrompts()` | skill-prompts.ts | Update prompts when skills change |
| `getPromptDescription()` | skill-prompts.ts | Usage text + skill list for prompt desc |
| `refreshSubscriptions()` | subscriptions.ts | Update watchers when skills change |
| `parseWellKnownUrl()` | well-known-config.ts | Normalize a publisher URL into `{origin, basePath}`, auto-appending `/.well-known/agent-skills` |
| `isOriginAllowed()` | well-known-config.ts | Default-deny allowlist check for well-known origins |
| `syncWellKnown()` | well-known-sync.ts | Fetch index.json, verify each entry's SHA-256 digest, write/extract into the cache |
| `validateIndexDocument()` | well-known-sync.ts | Shape-check a parsed index document and reject malformed entries |
| `archiveFormatFromUrl()` | well-known-sync.ts | Pick `tar.gz` / `zip` / `null` from an artifact URL |
| `hasRemoteUpdates()` | well-known-sync.ts | Conditional GET on index.json (ETag/If-Modified-Since) |
| `createWellKnownPollingManager()` | well-known-polling.ts | Periodic index re-check, mirrors GitHub polling shape |

## Well-Known Discovery (.well-known/agent-skills/)

Implements [the agent-skills discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc). Configure a publisher origin:

```bash
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/
```

- **Default-deny**: origins must be on the allowlist (env var or `wellKnownAllowedOrigins` in `~/.skilljack/config.json`).
- **Every fetched URL is allowlist-gated**: `assertUrlAllowed()` re-validates the index URL, each entry's artifact `url` (which may be absolute/cross-origin), and every redirect target against the allowlist + scheme rules. Redirects are followed manually (`redirect: "manual"`, max 5 hops) so a `3xx` can't escape the allowlist after the initial check. This prevents an allowlisted-but-malicious publisher from pointing an artifact at an internal host (SSRF) or an off-allowlist CDN.
- **Digest verification**: every artifact byte stream is SHA-256-hashed and compared against the index entry's `digest` (`sha256:<64 hex>`). Mismatch → entry is rejected and not written to disk.
- **Archive safety**: `.tar.gz` (via `tar`) and `.zip` (via `yauzl-promise`) are extracted with rejection of absolute paths, parent traversal (`..`), symlinks/hardlinks, and uncompressed sizes over `WELL_KNOWN_MAX_UNPACKED_MB`.
- **Cache layout**: `~/.skilljack/well-known-cache/<host-slug>[_<path-slug>]/skills/<skill-name>/SKILL.md`. The `skills/` root is added to `currentSkillsDirs` so `discoverSkills()` picks them up like any local source.
- **Conditional refetch**: `index.json` ETag/Last-Modified are stored alongside the cache and replayed via `If-None-Match` / `If-Modified-Since` on the next poll.
- **Pruning**: skills removed from the index have their per-skill cache directories deleted on the next sync.

## Modification Guide

| To add... | Modify... |
|-----------|-----------|
| New tool | `skill-tool.ts` - use `server.registerTool()` |
| New prompt | `skill-prompts.ts` - use `server.registerPrompt()` |
| New resource | `skill-resources.ts` - use `server.registerResource()` |
| Skill discovery logic | `skill-discovery.ts` |
| File watching behavior | `index.ts` - `watchSkillDirectories()` |
| Refresh logic | `index.ts` - `refreshSkills()` |

## Capabilities

```typescript
capabilities: {
  tools: { listChanged: !isStatic },      // Dynamic tool updates (disabled in static mode)
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: !isStatic },    // Dynamic prompt updates (disabled in static mode)
  extensions: {
    "io.modelcontextprotocol/skills": {}, // SEP-2640 Skills Extension
  },
}
```

In static mode (`--static` or `SKILLJACK_STATIC=true`), `tools.listChanged` and `prompts.listChanged` are set to `false`. Resource subscriptions remain fully dynamic.

## Resource URIs (SEP-2640)

The resource layer follows [SEP-2640 (Skills Extension)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640):

| URI | Returns |
|-----|---------|
| `skill://<skill-path>/SKILL.md` | The skill's SKILL.md (`text/markdown`). Listed. |
| `skill://<skill-path>/<file-path>` | A supporting file inside the skill directory. Listed in `resources/list`, lower priority than `SKILL.md`. |
| `skill://index.json` | SEP-2640 discovery index (`application/json`). Listed. |

`<skill-path>` is `<prefix>/<baseName>` for prefixed skills (local: dir basename, GitHub: `owner-repo`) or just `<baseName>` for bundled. The final URI segment always equals the frontmatter `name` per SEP. Build/parse via `buildSkillResourceUri()` / `parseSkillResourceUri()` in `skill-discovery.ts`.

## Notifications Sent

- `notifications/tools/list_changed` - When skills change (add/modify/remove)
- `notifications/prompts/list_changed` - When skills change (add/modify/remove)
- `notifications/resources/list_changed` - When skills change
- `notifications/resources/updated` - When subscribed resource files change. Also fired explicitly for `skill://index.json` from `refreshSkills()` so subscribers see add/remove changes even without an underlying SKILL.md modification.

## Conventions

- ES modules (`.js` extensions in imports)
- **Tool search / deferred tools:** the skill catalog is delivered through exactly ONE channel, selected by `--catalog=` / `SKILLJACK_CATALOG` (never both simultaneously). In the default `instructions` mode the catalog arrives via the `initialize` handshake and **survives tool search** (verified by evals 2026-07-05: 3/3 previously-failing tasks pass with instructions + tool search on), at the cost of being frozen at startup on stdio (the SDK cannot update instructions after construction). On HTTP the catalog stays fresh for *new* connections: file watchers/polling update skillState and instructions are regenerated per request — but MCP only delivers instructions at `initialize`, so already-connected clients see catalog changes only after reconnecting. In `tool-description` mode the catalog is dynamic via `tools/listChanged`, but clients with tool search / deferred tool loading enabled (default on modern Claude Code) defer MCP tool descriptions out of context, so the model never sees it and won't auto-activate — that mode needs `ENABLE_TOOL_SEARCH=false`. **`tool-description` is legacy and not recommended** (measured 2026-07-06, issue #78): it has no steady-state cost advantage (with tool search off, both modes cost the same ~$0.73–0.94/eval vs $0.15–0.21 for the default, because loading all tool definitions upfront dominates), and its live-refresh advantage is a prompt-cache trap — tool definitions sit at the top of the cached prompt prefix, so every `tools/listChanged` catalog refresh invalidates the entire cache (tools + system prompt + conversation) and re-writes it at cache-write prices. It is retained only as an escape hatch and as the evals' control condition. Issue #78 now tracks only the stdio instructions-freeze gap.
- Transports: stdio (default, full dynamic refresh + UI config/display tools) or stateless HTTP (`--http`, core skill surface only, per-request `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, no push notifications). `main()` branches to `startHttpServer()` right after startup discovery, first wiring the same file watchers + remote polling as stdio to a state-only refresh (`refreshSkillState`) — requests read skillState fresh, clients just aren't notified.
- Errors logged to stderr (stdout is MCP protocol)
- Security: path traversal checks via `isPathWithinBase()`
- File size limit: 1MB default (`MAX_FILE_SIZE_MB` env var to configure)
- Debouncing: 500ms for skill refresh, 100ms for resource notifications

## Testing

- **Automated:** `npm test` runs the vitest suite (`src/**/*.test.ts`), which CI also runs on every push/PR. Add unit tests alongside the code they cover.
- Interactive/manual testing can also be done with the MCP Inspector and Playwright MCP.
- Check for a `TEST_PLAN.md` for test cases.  If no test plan exists create a set of test scenarios in a file called `TEST_PLAN.md`
- Once testing is complete, always clean up the `TEST_PLAN.md` file and any generated or test files.
