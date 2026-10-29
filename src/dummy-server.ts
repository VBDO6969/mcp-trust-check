import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Use serveStdio factory - it handles both modern (2026) and legacy (2025) lifecycles automatically
// See @modelcontextprotocol/server v2 docs: serveStdio owns era decision
serveStdio(() => {
  const server = new McpServer(
    { name: "dummy-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "get_weather",
    {
      description: "Get current weather for a city",
      inputSchema: z.object({
        city: z.string().describe("City name"),
      }),
    },
    async ({ city }) => {
      return {
        content: [{ type: "text", text: `Weather in ${city}: sunny, 22C` }],
      };
    }
  );

  server.registerTool(
    "add_numbers",
    {
      description: "Add two numbers together",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
    },
    async ({ a, b }) => {
      const sum = a + b;
      return {
        content: [{ type: "text", text: `Sum is ${sum}` }],
      };
    }
  );

  return server;
});

// Log to stderr only (stdout is reserved for protocol)
console.error("dummy-server started (MCP stdio, dual lifecycle via serveStdio)");
