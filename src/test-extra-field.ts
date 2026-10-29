import { fetchToolDefinitions } from "./client.js";

async function test() {
  console.log("=== Testing extra field preservation (McpServer _meta) ===");
  let result = await fetchToolDefinitions("npx", ["tsx", "src/dummy-server-extra-field.ts"], { timeoutMs: 5000 });
  console.log(`Lifecycle: ${result.lifecycle}, version: ${result.protocolVersion}`);
  console.log(`Tools count: ${result.tools.length}`);
  for (const tool of result.tools) {
    console.log(`\nTool: ${(tool as any).name}`);
    console.log(JSON.stringify(tool, null, 2));
    const hasMeta = !!(tool as any)._meta;
    const hasXCustom = !!(tool as any).x_custom || !!(tool as any)._meta?.x_custom || !!(tool as any).x_custom_top || !!(tool as any).x_hidden;
    console.log(`  has _meta: ${hasMeta}, has x_custom-like: ${hasXCustom}`);
    if (hasMeta) console.log(`  _meta value: ${JSON.stringify((tool as any)._meta)}`);
  }

  console.log("\n=== Testing extra field preservation (raw server x_custom) ===");
  result = await fetchToolDefinitions("npx", ["tsx", "src/failure-servers/extra-field-raw.ts"], { timeoutMs: 5000 });
  console.log(`Lifecycle: ${result.lifecycle}, version: ${result.protocolVersion}`);
  console.log(`Tools count: ${result.tools.length}`);
  for (const tool of result.tools) {
    console.log(`\nTool: ${(tool as any).name}`);
    console.log(JSON.stringify(tool, null, 2));
    const hasMeta = !!(tool as any)._meta;
    const hasXCustomTop = !!(tool as any).x_custom_top;
    const hasXHidden = !!(tool as any).x_hidden;
    console.log(`  has _meta: ${hasMeta}, has x_custom_top: ${hasXCustomTop}, has x_hidden: ${hasXHidden}`);
    if (hasMeta) console.log(`  _meta value: ${JSON.stringify((tool as any)._meta)}`);
  }

  console.log("\n=== TEST SUMMARY ===");
  console.log("If _meta is preserved, Layer 1 can hash it. If x_custom_top is stripped, that's a vulnerability.");
}

test().catch(e => { console.error("Test failed:", e.message); console.error(e); process.exit(1); });
