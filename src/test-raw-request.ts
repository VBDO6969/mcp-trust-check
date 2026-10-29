import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

async function testRaw() {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/failure-servers/extra-field-raw.ts"], stderr: "pipe" });
  const client = new Client({ name: "test-raw", version: "1.0.0" }, { capabilities: {}, listMaxPages: 100, versionNegotiation: { mode: "legacy" } });
  await client.connect(transport as any, { timeout: 5000 } as any);
  console.log("Connected, era:", (client as any).getProtocolEra(), "version:", (client as any).getNegotiatedProtocolVersion());

  // Try standard listTools (should strip)
  const standard = await (client as any).listTools(undefined, { timeout: 5000 });
  console.log("\n=== Standard listTools (may strip) ===");
  console.log(JSON.stringify(standard.tools[0], null, 2));
  console.log("Has x_custom_top (standard):", !!(standard.tools[0] as any).x_custom_top);

  // Try raw request with passthrough
  const looseSchema = z.object({
    tools: z.array(z.record(z.string(), z.unknown())),
    nextCursor: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  }).passthrough();
  // Also try with zod v4's passthrough via .passthrough()
  const raw = await (client as any).request({ method: "tools/list" }, looseSchema, { timeout: 5000 });
  console.log("\n=== Raw request with passthrough ===");
  console.log(JSON.stringify((raw as any).tools[0], null, 2));
  console.log("Has x_custom_top (raw):", !!(raw as any).tools[0].x_custom_top);
  console.log("Has x_hidden (raw):", !!(raw as any).tools[0].x_hidden);
  console.log("Has _meta (raw):", !!(raw as any).tools[0]._meta);

  await client.close();
  await transport.close();
  console.log("\nTest done");
}
testRaw().catch(e => { console.error(e); process.exit(1); });
