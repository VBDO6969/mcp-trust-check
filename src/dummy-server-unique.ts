import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const unique = process.argv[2] || "unique";
serveStdio(() => {
  const server = new McpServer({ name: "dummy-unique", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(unique, { description: `Tool ${unique}`, inputSchema: z.object({ x: z.string() }) }, async ({ x }) => ({ content: [{ type: "text", text: x }] }));
  return server;
});
console.error(`dummy-unique started with tool ${unique}`);
