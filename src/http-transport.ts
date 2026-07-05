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
 * resources/updated notifications are not delivered. Skills are read from the
 * skillState captured at startup; restart to pick up on-disk changes. The
 * default stdio transport keeps full dynamic-refresh behavior.
 */

import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerSkillTool, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts } from "./skill-prompts.js";
import { generateInstructions, getModelInvocableSkills } from "./skill-discovery.js";

/**
 * Build a fresh McpServer exposing the core skill surface for one request.
 *
 * listChanged/subscribe are advertised as false: stateless HTTP cannot push
 * notifications, so promising them would be dishonest.
 */
export function buildCoreServer(skillState: SkillState): McpServer {
  const skills = Array.from(skillState.skillMap.values());
  const instructions = generateInstructions(getModelInvocableSkills(skills));

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
      instructions,
    }
  );

  registerSkillTool(server, skillState);
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
export async function startHttpServer(port: number, skillState: SkillState): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !(url === "/mcp" || url.startsWith("/mcp?"))) {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSONRPC_ERROR(-32000, "Only POST /mcp is supported (stateless mode)"));
      return;
    }

    // Fresh server + transport per request (stateless).
    const server = buildCoreServer(skillState);
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
