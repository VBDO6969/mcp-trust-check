// garbage-text-stay-alive: plain non-JSON stdout spec violation, stays alive to trigger timeout
// MCP spec 2026-07-28 says servers MUST NOT write anything to stdout that is not a valid MCP message.
// This server violates by printing plain text to stdout, which ReadBuffer silently skips (SyntaxError continue).
// Our client now detects and reports: "Server wrote N non-JSON line(s) to stdout (spec violation), first: ..."
console.log("THIS IS NOT JSON - plain text spec violation line 1");
console.log("SECOND LINE WITH EXTRA LONG CONTENT TO TEST TRUNCATION " + "A".repeat(250) + " TAIL");
console.log("THIRD plain text violation - should be kept as third sample");
console.error("garbage-text-stay-alive: wrote plain text to stdout (spec violation), staying alive to trigger timeout");
let count = 3;
setInterval(() => {
  count++;
  if (count <= 12) {
    console.log(`Additional violation line ${count} after startup - plain text count test`);
  }
  console.error(`garbage-text-stay-alive: tick ${count}`);
}, 400);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  console.error(`garbage-text-stay-alive: received ${chunk.length} bytes but ignoring (no MCP response)`);
});
process.on("SIGTERM", () => {
  console.error("garbage-text-stay-alive: SIGTERM received");
  process.exit(0);
});
