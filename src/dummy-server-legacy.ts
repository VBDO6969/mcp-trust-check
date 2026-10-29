// Legacy dummy server - forces legacy mode by rejecting modern discover
// In SDK v2, serveStdio handles both, but we can simulate legacy by using legacy: serve option
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "dummy-legacy-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool("get_weather", { description: "Get current weather for a city (legacy)", inputSchema: z.object({ city: z.string() }) }, async ({ city }) => ({ content: [{ type: "text", text: `Legacy weather in ${city}: cloudy 18C` }] }));
  server.registerTool("add_numbers", { description: "Add two numbers (legacy)", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a,b }) => ({ content: [{ type: "text", text: `Sum is ${a+b}` }] }));
  return server;
}, { legacy: "serve" });
console.error("dummy-legacy-server: started (legacy mode forced)");
