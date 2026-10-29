#!/usr/bin/env node
// Infinite pagination server - returns nextCursor forever to test safety cap
// Should cause client to throw after 100 pages (or custom maxPages)
import { stdin, stdout } from "node:process";

console.error("pagination-infinite: started, will paginate forever");

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
stdin.on("end", () => { console.error("pagination-infinite: stdin closed"); process.exit(0); });

function send(obj: unknown) { stdout.write(JSON.stringify(obj) + "\n"); }

let page = 0;
function handleLine(line: string) {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  const method = msg.method;
  if (method === "notifications/initialized") return;
  if (method === "server/discover") {
    console.error("pagination-infinite: discover -> reject to force legacy");
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "pagination-infinite", version: "1.0.0" } } });
    return;
  }
  if (method === "tools/list") {
    const cursor = msg.params?.cursor;
    const currentPage = cursor ? parseInt(cursor, 10) : 0;
    console.error(`pagination-infinite: tools/list cursor=${cursor ?? "none"} -> page ${currentPage}`);
    const nextCursor = String(currentPage + 1); // Always has next, infinite
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{ name: `tool_page_${currentPage}`, description: `Tool on page ${currentPage}`, inputSchema: { type: "object", properties: {} } }],
        nextCursor,
      },
    });
    return;
  }
  if (method === "ping") { if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
process.on("SIGTERM", () => { console.error("pagination-infinite: SIGTERM"); process.exit(0); });
