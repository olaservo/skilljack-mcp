/**
 * Stateless (sessionless) HTTP transport for skilljack.
 *
 * Serves the core skill surface (load-skill, skill-resource, skill:// resources,
 * skills/list + skills/get, and /skill prompts) over Streamable HTTP at
 * POST /mcp through the SDK's era-aware `createMcpHandler`: 2026-07-28 clients
 * (per-request `_meta` envelope, no initialize handshake) and 2025-era clients
 * (initialize handshake, served by the handler's stateless legacy fallback)
 * are both answered by a fresh McpServer from `buildCoreServer` per request,
 * so no session state is retained between requests.
 *
 * Limitation: stateless mode has no server->client stream, so listChanged /
 * resources/updated notifications are not delivered. Discovery-on-change still
 * works: main() runs the same file watchers / remote polling as stdio and swaps
 * skillState, and every request reads that state fresh — but clients are not
 * *told* about changes; they see them on their next request (or, for the
 * instructions catalog, their next initialize/reconnect).
 */

import * as http from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  registerSkillTool,
  installToolsMode,
  getServerInstructions,
  SkillState,
  CatalogMode,
  ToolsMode,
} from "./skill-tool.js";
import { createSkillsExtension, registerSkillResources } from "./skill-resources.js";
import type { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { registerSkillPrompts } from "./skill-prompts.js";

/**
 * Build a fresh McpServer exposing the core skill surface for one request.
 *
 * listChanged/subscribe are advertised as false: stateless HTTP cannot push
 * notifications, so promising them would be dishonest.
 *
 * catalogMode picks which single channel carries the skill catalog (tool
 * description or server instructions — see CatalogMode). Instructions are
 * regenerated from the current skillState on every request (unlike stdio,
 * where the SDK freezes them at construction), so newly connecting clients
 * see skill changes picked up by the watchers in main().
 */
export function buildCoreServer(
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions",
  toolsMode: ToolsMode = "auto",
  skills: SkillsExtension = createSkillsExtension(skillState)
): McpServer {
  // Stateless HTTP builds a server per request, so the initialize handshake
  // is never visible to the instance that answers tools/list: "auto" cannot
  // gate here and behaves as "always".
  const effectiveToolsMode: ToolsMode = toolsMode === "auto" ? "always" : toolsMode;
  const instructions = getServerInstructions(skillState, catalogMode, effectiveToolsMode);

  const server = new McpServer(
    { name: "skilljack-mcp", version: "0.15.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        // The skills extension (SEP-2640) declares its own capability on attach.
      },
      ...(instructions !== undefined && { instructions }),
    }
  );

  const skillTools = registerSkillTool(server, skillState, catalogMode);
  registerSkillResources(server, skillState, skills);
  registerSkillPrompts(server, skillState);
  installToolsMode(server, skillTools, effectiveToolsMode, catalogMode);

  return server;
}

const JSONRPC_ERROR = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

/**
 * Start a stateless Streamable HTTP MCP server on the given port.
 * Resolves with the listening http.Server once it is accepting connections.
 *
 * One factory backs both protocol eras: `createMcpHandler` builds a fresh
 * core server per request, serving 2026-07-28 traffic natively and 2025-era
 * traffic through its stateless legacy fallback (`legacy: "stateless"`, the
 * default). Constructing a `NodeStreamableHTTPServerTransport` by hand would
 * pin every connection to 2025-11-25, on which `skills/list` / `skills/get`
 * cannot carry the `ttlMs` / `cacheScope` attributes SEP-2640 requires.
 */
export async function startHttpServer(
  port: number,
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions",
  toolsMode: ToolsMode = "auto"
): Promise<http.Server> {
  // One extension instance serves every per-request server.
  const skills = createSkillsExtension(skillState);
  const handler = createMcpHandler(() => buildCoreServer(skillState, catalogMode, toolsMode, skills), {
    onerror: (err) => console.error("HTTP MCP:", err.message),
  });
  const handleMcp = toNodeHandler(handler, {
    onerror: (err) => console.error("HTTP MCP request error:", err),
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (!(url === "/mcp" || url.startsWith("/mcp?"))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSONRPC_ERROR(-32000, "Not found: MCP is served at POST /mcp"));
      return;
    }
    if (req.method !== "POST") {
      // Stateless serving has no GET stream and no DELETE session, on either era.
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSONRPC_ERROR(-32000, "Only POST /mcp is supported (stateless mode)"));
      return;
    }
    await handleMcp(req, res);
  });
  httpServer.on("close", () => {
    void handler.close();
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.error(`Skilljack ready on http://localhost:${boundPort}/mcp (stateless HTTP). I know kung fu.`);
  return httpServer;
}
