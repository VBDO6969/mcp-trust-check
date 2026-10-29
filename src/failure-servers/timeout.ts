// Never-responds failure server: accepts connection but never replies, triggering timeout
console.error("never-responds: started - will ignore all input to trigger client timeout");
// Read stdin but never respond; keep process alive
process.stdin.resume();
process.stdin.on("data", () => {
  console.error("never-responds: received data but ignoring (simulating hang)");
  // Do NOT write to stdout - just ignore
});
// Keep alive indefinitely; client timeout will fire
setInterval(() => {}, 1000);
