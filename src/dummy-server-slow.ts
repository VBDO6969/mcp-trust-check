// Alias for npm script test:timeout — intentional duplicate of failure-servers/timeout.ts with distinct stderr
console.error("dummy-server-slow: started - will not respond (timeout test)");
process.stdin.resume();
process.stdin.on("data", () => {
  console.error("dummy-server-slow: ignoring data");
});
setInterval(() => {}, 1000);
