// Paginated tools server: demonstrates nextCursor handling
// Uses McpServer with 5 tools to exercise pagination (SDK may auto-paginate or client will handle cursor)
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "paginated-server", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.registerTool("tool_a", { description: "Tool A", inputSchema: z.object({ x: z.string() }) }, async ({ x }) => ({ content: [{ type: "text", text: x }] }));
  server.registerTool("tool_b", { description: "Tool B", inputSchema: z.object({ y: z.number() }) }, async ({ y }) => ({ content: [{ type: "text", text: String(y) }] }));
  server.registerTool("tool_c", { description: "Tool C", inputSchema: z.object({ z: z.boolean() }) }, async ({ z }) => ({ content: [{ type: "text", text: String(z) }] }));
  server.registerTool("tool_d", { description: "Tool D", inputSchema: z.object({ q: z.string() }) }, async ({ q }) => ({ content: [{ type: "text", text: q }] }));
  server.registerTool("tool_e", { description: "Tool E", inputSchema: z.object({ w: z.string() }) }, async ({ w }) => ({ content: [{ type: "text", text: w }] }));

  return server;
});

console.error("paginated-server: started with 5 tools");
