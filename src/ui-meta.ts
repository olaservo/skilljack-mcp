/**
 * Vendored MCP Apps (UI) server helpers — a faithful port of the three functions the
 * server half of this package used from `@modelcontextprotocol/ext-apps/server`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `@modelcontextprotocol/ext-apps` (latest release: 1.7.5) is hard-bound to MCP
 * TypeScript SDK **v1**: its server helpers are typed against v1's `McpServer`, it
 * imports `@modelcontextprotocol/sdk/server/zod-compat.js` (removed in v2), and its
 * peerDependency is `"@modelcontextprotocol/sdk": "^1.29.0"`. There is no
 * v2-compatible release, so the server — now on `@modelcontextprotocol/server@2` —
 * cannot import `@modelcontextprotocol/ext-apps/server` at all.
 *
 * The port below is behaviourally identical to ext-apps@1.7.5's
 * `dist/src/server/index.js`, only retyped against the v2 SDK surface. That matters:
 * hosts (including Claude) locate a tool's UI resource by reading
 * `_meta['ui/resourceUri']` and/or `_meta.ui.resourceUri`, so the emitted `_meta` must
 * stay byte-identical to what ext-apps produced or the app silently stops rendering.
 *
 * DELETE THIS FILE — and go back to importing these from
 * `@modelcontextprotocol/ext-apps/server` — as soon as ext-apps ships a release that
 * supports SDK v2.
 *
 * Note: the browser half of this package (`src/ui/**`) still imports ext-apps
 * directly and still builds against SDK v1. That is safe because Vite bundles it
 * separately into self-contained HTML that runs in an iframe and only ever talks to
 * this server over the MCP wire — no v1 object ever flows into v2 code in-process.
 */

import type {
  ClientCapabilities,
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  RegisteredTool,
  ResourceMetadata,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";

/**
 * Legacy (flat) `_meta` key carrying a tool's UI resource URI.
 * Verbatim from ext-apps@1.7.5. Still read by hosts, so still emitted.
 */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";

/** MIME type identifying an MCP Apps HTML resource. Verbatim from ext-apps@1.7.5. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** Client-capability extension id for MCP Apps. Verbatim from ext-apps@1.7.5. */
export const EXTENSION_ID = "io.modelcontextprotocol/ui";

/** Who may call a UI-backed tool: the model, the app itself, or both. */
export type McpUiToolVisibility = "model" | "app";

/** UI-related metadata for a tool (ext-apps `McpUiToolMeta`). */
export interface McpUiToolMeta {
  /** URI of the UI resource to display for this tool, e.g. `ui://weather/view.html`. */
  resourceUri?: string;
  /** Who can access this tool. Default: `["model", "app"]`. */
  visibility?: McpUiToolVisibility[];
}

/**
 * `_meta` accepted by {@link registerAppTool}: either the preferred nested
 * `{ ui: { resourceUri } }` form or the deprecated flat `"ui/resourceUri"` key.
 * Whichever is supplied, {@link normalizeUiToolMeta} emits both.
 */
export type McpUiAppToolMeta = { [key: string]: unknown } & (
  | { ui: McpUiToolMeta }
  | { [RESOURCE_URI_META_KEY]?: string }
);

/**
 * Mirror a UI resource URI across both `_meta` keys.
 *
 * Port of ext-apps@1.7.5's only behaviour beyond `server.registerTool`:
 * if the nested `ui.resourceUri` is set but the legacy flat key is not, add the flat
 * key; if only the legacy key is set, add the nested one; otherwise pass `_meta`
 * through untouched (including when both are already present — the caller's values
 * win and are never reconciled).
 */
export function normalizeUiToolMeta(meta: McpUiAppToolMeta): Record<string, unknown> {
  const source = meta as Record<string, unknown>;
  const ui = source.ui as McpUiToolMeta | undefined;
  const legacy = source[RESOURCE_URI_META_KEY] as string | undefined;

  if (ui?.resourceUri && !legacy) {
    return { ...source, [RESOURCE_URI_META_KEY]: ui.resourceUri };
  }
  if (legacy && !ui?.resourceUri) {
    return { ...source, ui: { ...ui, resourceUri: legacy } };
  }
  return source;
}

/**
 * Register a tool that renders an MCP App, normalizing its UI `_meta`.
 *
 * Equivalent to `server.registerTool(name, config, cb)` with `config._meta` passed
 * through {@link normalizeUiToolMeta} first — that normalization is the entire
 * difference, exactly as in ext-apps@1.7.5.
 */
export function registerAppTool<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta: McpUiAppToolMeta;
  },
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  return server.registerTool<OutputArgs, InputArgs>(
    name,
    { ...config, _meta: normalizeUiToolMeta(config._meta) },
    cb,
  );
}

/**
 * Register the HTML resource an MCP App tool points at.
 *
 * Equivalent to `server.registerResource(name, uri, config, readCallback)` with the
 * MCP Apps MIME type defaulted in. The default is spread FIRST, so a caller-supplied
 * `mimeType` still wins — same as ext-apps@1.7.5.
 */
export function registerAppResource(
  server: McpServer,
  name: string,
  uri: string,
  config: ResourceMetadata,
  readCallback: ReadResourceCallback,
): RegisteredResource {
  return server.registerResource(name, uri, { mimeType: RESOURCE_MIME_TYPE, ...config }, readCallback);
}

/**
 * Read the client's MCP Apps capability, if it advertised one.
 * Port of ext-apps@1.7.5's `getUiCapability`.
 */
export function getUiCapability(clientCapabilities: ClientCapabilities | undefined): unknown {
  if (!clientCapabilities) return undefined;
  return (clientCapabilities as { extensions?: Record<string, unknown> }).extensions?.[EXTENSION_ID];
}
