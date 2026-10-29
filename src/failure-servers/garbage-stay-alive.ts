// Garbage-stay-alive: writes invalid JSON-RPC to stdout and stays alive
// To ensure client detects it as parse error (not silently skipped), we send valid JSON that fails JSON-RPC validation
// Plain text garbage is silently skipped by SDK (SyntaxError continue), so we send {"not":"jsonrpc"} which triggers validation error
console.log('{"not":"jsonrpc","garbage":true}');
console.log('{"invalid":"json-rpc","id":1}');
console.error("garbage-stay-alive: wrote invalid JSON-RPC (valid JSON but not JSON-RPC) to stdout, staying alive to trigger parse error");

let count = 0;
setInterval(() => {
  // Alternate between plain text (skipped) and invalid JSON (triggers error)
  if (count % 2 === 0) {
    console.log(`{"garbage_line":${++count},"not":"jsonrpc"}`);
  } else {
    console.log(`THIS IS NOT JSON-RPC - GARBAGE LINE ${++count} {{{ not json`);
  }
  console.error(`garbage-stay-alive: wrote garbage line ${count}`);
}, 150);

process.stdin.resume();
process.stdin.on("data", (chunk) => {
  console.error(`garbage-stay-alive: received data (${chunk.length} bytes) but ignoring - continuing garbage`);
  // Do NOT write valid JSON-RPC response, keep sending garbage
});

// Keep process alive, handle SIGTERM gracefully for cleanup test
process.on("SIGTERM", () => {
  console.error("garbage-stay-alive: SIGTERM received");
  process.exit(0);
});
