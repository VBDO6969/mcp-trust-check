#!/usr/bin/env node
/**
 * Legacy-only dummy server - raw JSON-RPC implementation
 * Forces legacy lifecycle (2025-11-25) by rejecting modern server/discover
 * Used to prove fallback works and logs "legacy"
 *
 * Handles:
 * - server/discover -> -32601 Method not found (forces modern probe to fail)
 * - initialize -> 2025-11-25
 * - notifications/initialized -> no-op
 * - tools/list -> 2 tools
 * - tools/call, ping -> minimal
 *
 * stdout ONLY protocol messages, stderr for logs
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

console.error("dummy-legacy-only: started (raw JSON-RPC, legacy 2025-11-25 only, rejects discover)");

stdin.setEncoding("utf-8");
let buffer = "";

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
  // Client closed stdin -> exit promptly per MCP stdio spec
  console.error("dummy-legacy-only: stdin closed, exiting");
  process.exit(0);
});

function send(obj: unknown) {
  stdout.write(JSON.stringify(obj) + "\n");
}

function handleLine(line: string) {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    // Ignore non-JSON? But we are server, client should not send garbage
    console.error(`dummy-legacy-only: failed to parse line: ${line}`);
    return;
  }

  const id = msg.id;
  const method = msg.method;

  // Notifications have no id (e.g. notifications/initialized)
  if (msg.method === "notifications/initialized") {
    console.error("dummy-legacy-only: received notifications/initialized");
    return;
  }

  if (method === "server/discover") {
    console.error("dummy-legacy-only: received server/discover -> rejecting with -32601 to force legacy fallback");
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found: server/discover - legacy only server" },
      });
    }
    return;
  }

  if (method === "initialize") {
    console.error(`dummy-legacy-only: received initialize (protocolVersion=${msg.params?.protocolVersion}) -> responding 2025-11-25 legacy`);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "dummy-legacy-only",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (method === "tools/list") {
    console.error("dummy-legacy-only: received tools/list");
    const tools = [
      {
        name: "get_weather",
        description: "Get current weather for a city (legacy-only)",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
      {
        name: "add_numbers",
        description: "Add two numbers together (legacy-only)",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number", description: "First number" },
            b: { type: "number", description: "Second number" },
          },
          required: ["a", "b"],
        },
      },
    ];

    // Support pagination if cursor provided, though we only have 2 tools (no pagination needed)
    // Just return all
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools,
        // no nextCursor -> done
      },
    });
    return;
  }

  if (method === "ping") {
    if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Unknown method
  if (id !== undefined) {
    console.error(`dummy-legacy-only: unknown method ${method} -> -32601`);
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

// Handle SIGTERM etc
process.on("SIGTERM", () => {
  console.error("dummy-legacy-only: SIGTERM received, exiting");
  process.exit(0);
});
