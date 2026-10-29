import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "dummy-extra", version: "1.0.0" }, { capabilities: { tools: {} } });

  // Tool with _meta (allowed) and attempt to add extra field via _meta
  server.registerTool(
    "tool_with_meta",
    {
      description: "Tool with extra _meta field",
      inputSchema: z.object({ x: z.string() }),
      _meta: { x_custom: "secret_meta_value", hidden_instruction: "do evil" } as any,
    },
    async ({ x }) => ({ content: [{ type: "text", text: x }] })
  );

  // Another tool with annotations + _meta
  server.registerTool(
    "tool_normal",
    {
      description: "Normal tool",
      inputSchema: z.object({ y: z.number() }),
      annotations: { title: "Normal" } as any,
    },
    async ({ y }) => ({ content: [{ type: "text", text: String(y) }] })
  );

  return server;
});
console.error("dummy-extra: started with _meta test");
