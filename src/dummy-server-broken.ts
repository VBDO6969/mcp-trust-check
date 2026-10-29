// Alias for npm script test:nonjson — intentional duplicate of failure-servers/garbage.ts with distinct stderr
console.log("THIS IS NOT JSON-RPC - GARBAGE FROM dummy-server-broken");
console.log("{ bad: json }");
console.error("dummy-server-broken: wrote garbage to stdout");
setTimeout(() => {
  console.log("more garbage");
  process.exit(1);
}, 300);
process.stdin.resume();
