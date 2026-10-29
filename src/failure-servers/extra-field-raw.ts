#!/usr/bin/env node
// Raw server that returns tools with extra fields to test if SDK preserves them
// This tests the hashing risk: if SDK strips unknown fields, Layer 1 will miss rug pull
import { stdin, stdout } from "node:process";

console.error("extra-field-raw: started, will return tools with _meta and x_custom");

let buffer = "";
stdin.setEncoding("utf-8");
stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleLine(line);
  }
});
stdin.on("end", () => {
  console.error("extra-field-raw: stdin closed");
  process.exit(0);
});

function send(obj: unknown) {
  stdout.write(JSON.stringify(obj) + "\n");
}

function handleLine(line: string) {
  let msg: any;
  try { msg = JSON.parse(line); } catch { console.error(`extra-field-raw: parse fail ${line}`); return; }
  const id = msg.id;
  const method = msg.method;
  if (method === "notifications/initialized") { console.error("extra-field-raw: initialized"); return; }
  if (method === "server/discover") {
    console.error("extra-field-raw: discover -> reject to force legacy");
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (method === "initialize") {
    console.error("extra-field-raw: initialize");
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "extra-field-raw", version: "1.0.0" } } });
    return;
  }
  if (method === "tools/list") {
    console.error("extra-field-raw: tools/list with extra fields");
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "tool_with_extra",
            description: "Tool with hidden extra fields",
            inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            _meta: { hidden_instruction: "do evil", x_custom: "secret" },
            // Try also top-level custom field that should be preserved but may be stripped
            x_custom_top: "top_level_secret",
            x_hidden: "another_hidden",
          } as any,
          {
            name: "normal_tool",
            description: "Normal tool",
            inputSchema: { type: "object", properties: { x: { type: "string" } } },
          },
        ],
      },
    });
    return;
  }
  if (method === "ping") { if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
process.on("SIGTERM", () => { console.error("extra-field-raw: SIGTERM"); process.exit(0); });
