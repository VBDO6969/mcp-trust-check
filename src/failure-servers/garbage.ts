// Garbage-output failure server: writes non-JSON-RPC to stdout, should be detected as parse error or closure
console.log("THIS IS NOT JSON-RPC - GARBAGE OUTPUT {{{ not json");
console.log("{ invalid: json, missing quotes }");
console.error("garbage-output: wrote garbage to stdout (stderr log)");
// Exit quickly so client sees closure + garbage stderr, not just timeout
setTimeout(() => {
  console.log("more garbage: [[[@@@");
  console.error("garbage-output: exiting after garbage");
  process.exit(1);
}, 300);
process.stdin.resume();
