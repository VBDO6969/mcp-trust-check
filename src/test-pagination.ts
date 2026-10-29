import { fetchToolDefinitions } from "./client.js";

async function test() {
  console.log("=== Testing pagination cap (maxPages=3 should throw after 3) ===");
  try {
    const result = await fetchToolDefinitions("npx", ["tsx", "src/failure-servers/pagination-infinite.ts"], { timeoutMs: 5000, maxPages: 3 });
    console.log("UNEXPECTED: should have thrown but got", result.tools.length, "tools");
    console.log(result.tools.map(t => (t as any).name));
  } catch (e: any) {
    console.log("Correctly threw error for pagination cap:");
    console.log(e.message.split("\n")[0]); // First line
    if (e.message.includes("Pagination safety cap") || e.message.includes("exceeded") || e.message.includes("listMaxPages")) {
      console.log("PASS: Error mentions cap/exceeded");
    } else {
      console.log("FAIL: Error does not mention cap");
    }
  }

  console.log("\n=== Testing that normal pagination (5 tools, 1 page) does NOT throw ===");
  try {
    const result = await fetchToolDefinitions("npx", ["tsx", "src/failure-servers/paginated.ts"], { timeoutMs: 5000, maxPages: 100 });
    console.log(`Got ${result.tools.length} tools, no throw - PASS`);
  } catch (e) {
    console.log("FAIL: should not throw for normal pagination", e);
  }
}
test().catch(e => { console.error(e); process.exit(1); });
