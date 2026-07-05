/**
 * Stateless (sessionless) HTTP transport for skilljack.
 *
 * Serves the core skill surface (load-skill, skill-resource, skill:// resources,
 * and /skill prompts) over Streamable HTTP. Each POST /mcp is handled by a
 * fresh McpServer + StreamableHTTPServerTransport with `sessionIdGenerator:
 * undefined` (the SDK's stateless mode), so no session state is retained
 * between requests.
 *
 * Limitation: stateless mode has no server->client stream, so listChanged /
 * resources/updated notifications are not delivered. Discovery-on-change still
 * works: main() runs the same file watchers / remote polling as stdio and swaps
 * skillState, and every request reads that state fresh — but clients are not
 * *told* about changes; they see them on their next request (or, for the
 * instructions catalog, their next initialize/reconnect).
 */

import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerSkillTool, getServerInstructions, SkillState, CatalogMode } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
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
  catalogMode: CatalogMode = "instructions"
): McpServer {
  const instructions = getServerInstructions(skillState, catalogMode);

  const server = new McpServer(
    { name: "skilljack-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        // SEP-2640 (Skills Extension)
        extensions: {
          "io.modelcontextprotocol/skills": {},
        },
      },
      ...(instructions !== undefined && { instructions }),
    }
  );

  registerSkillTool(server, skillState, catalogMode);
  registerSkillResources(server, skillState);
  registerSkillPrompts(server, skillState);

  return server;
}

const JSONRPC_ERROR = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

/**
 * Start a stateless Streamable HTTP MCP server on the given port.
 * Resolves with the listening http.Server once it is accepting connections.
 */
export async function startHttpServer(
  port: number,
  skillState: SkillState,
  catalogMode: CatalogMode = "instructions"
): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !(url === "/mcp" || url.startsWith("/mcp?"))) {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSONRPC_ERROR(-32000, "Only POST /mcp is supported (stateless mode)"));
      return;
    }

    // Fresh server + transport per request (stateless).
    const server = buildCoreServer(skillState, catalogMode);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (err) {
      console.error("HTTP MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSONRPC_ERROR(-32603, "Internal server error"));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.error(`Skilljack ready on http://localhost:${boundPort}/mcp (stateless HTTP). I know kung fu.`);
  return httpServer;
}
