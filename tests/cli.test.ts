import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

let fakeServer: ReturnType<typeof createServer> | null = null;
let fakePort = 0;
let requestCount = 0;
let shouldReturn500 = false;

before(async () => {
  fakeServer = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return;
    }
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      requestCount++;
      if (shouldReturn500) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server error" })); return;
      }
      const isSuspicious = body.includes("attacker.example");
      const reason = isSuspicious ? "attempts to exfiltrate environment variables to attacker.example" : "no suspicious instructions found";
      const resp = { choices: [{ message: { content: JSON.stringify({ suspicious: isSuspicious, reason }) } }] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  await new Promise<void>((resolve) => fakeServer!.listen(0, "127.0.0.1", () => {
    const addr = fakeServer!.address() as any; fakePort = addr.port; resolve();
  }));
});

after(async () => {
  if (fakeServer) await new Promise<void>((res) => fakeServer!.close(() => res()));
  try {
    const files = await readdir("baselines");
    for (const f of files) {
      const p = join("baselines", f);
      try { const raw = await readFile(p, "utf-8"); if (raw.includes("__cli_test_")) await rm(p, { force: true }); } catch {}
    }
  } catch {}
  try { await rm("src/dummy-server-rug-pull.state.json", { force: true }); } catch {}
  try { await rm("baselines/__test_cli_name.json", { force: true }); } catch {}
  try { await rm(join("baselines", "31beea1d546d1c70.json"), { force: true }); } catch {}
  try { await rm(join("baselines", "fbc0f37e15e9bd89.json"), { force: true }); } catch {}
  const { createHash } = await import("node:crypto");
  const canPoisoned = `npx\x00tsx\x00src/dummy-server-poisoned.ts`;
  const hashPoisoned = createHash("sha256").update(canPoisoned).digest("hex").slice(0, 16);
  try { await rm(join("baselines", `${hashPoisoned}.json`), { force: true }); } catch {}
  const canBenign = `npx\x00tsx\x00src/dummy-server-benign-change.ts`;
  const hashBenign = createHash("sha256").update(canBenign).digest("hex").slice(0,16);
  try { await rm(join("baselines", `${hashBenign}.json`), { force: true }); } catch {}
});

function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, BASETEN_API_KEY: "test-key", MCP_TRUST_CHECK_REVIEWER_ENDPOINT: `http://127.0.0.1:${fakePort}/v1/chat/completions`, ...extraEnv };
    for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete (env as any)[k];
    const child = spawn("cmd", ["/c", "npx", "tsx", "src/cli.ts", ...args], { stdio: ["pipe", "pipe", "pipe"], env } as any);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e) }));
    child.stdin.end();
  });
}
async function getBaselineFiles(): Promise<string[]> {
  try { const files = await readdir("baselines"); return files.filter((f) => f.endsWith(".json")); } catch { return []; }
}
describe("CLI approve/check with reviewer", () => {
  const testSuffix = `__cli_test_${Date.now()}`;
  const dummyArgs = ["tsx", "src/dummy-server.ts", testSuffix];
  it("approve twice unchanged (exit 0, file untouched) - second makes zero requests", async () => {
    requestCount = 0;
    const r1 = await runCli(["approve", "--accept", "npx", ...dummyArgs]);
    assert.equal(r1.code, 0, `first approve should exit 0, got ${r1.code} stderr=${r1.stderr}`);
    const filesBefore = await getBaselineFiles();
    let baselinePath = "";
    for (const f of filesBefore) {
      const raw = await readFile(join("baselines", f), "utf-8");
      if (raw.includes(testSuffix)) { baselinePath = join("baselines", f); break; }
    }
    assert.ok(baselinePath, "baseline file should exist after first approve");
    const stat1 = await stat(baselinePath);
    requestCount = 0;
    const r2 = await runCli(["approve", "npx", ...dummyArgs]);
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.includes("already approved, unchanged") || r2.stderr.includes("already approved"));
    const stat2 = await stat(baselinePath);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs);
    assert.equal(requestCount, 0, "second approve with no diff should make zero reviewer requests");
  });
  it("rug-pull without --accept in non-TTY should exit 1 and not overwrite", async () => {
    try { await rm("src/dummy-server-rug-pull.state.json", { force: true }); } catch {}
    try { await rm("baselines/31beea1d546d1c70.json", { force: true }); } catch {}
    try { await rm("baselines/fbc0f37e15e9bd89.json", { force: true }); } catch {}
    requestCount = 0;
    const r1 = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r1.code, 0);
    const { getBaselinePath } = await import("../src/baseline.js");
    const rugPath = getBaselinePath("npx", ["tsx", "src/dummy-server-rug-pull.ts"]);
    const beforeContent = await readFile(rugPath, "utf-8");
    assert.ok(beforeContent.includes("Get current weather for a city") && !beforeContent.includes("attacker"));
    const statBefore = await stat(rugPath);
    requestCount = 0;
    const r2 = await runCli(["approve", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r2.code, 1);
    assert.ok(requestCount > 0, "should have called reviewer for diff");
    assert.ok(r2.stderr.includes("SUSPICIOUS") || r2.stderr.includes("flagged"), `stderr should mention flagged: ${r2.stderr}`);
    const afterContent = await readFile(rugPath, "utf-8");
    assert.equal(beforeContent, afterContent, "baseline should not be overwritten");
    const statAfter = await stat(rugPath);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
  });
  it("rug-pull with --accept should replace and show diff", async () => {
    requestCount = 0;
    const r = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("WARNING") && r.stderr.includes("flagged"), `should print WARNING with flagged: ${r.stderr}`);
    const { getBaselinePath } = await import("../src/baseline.js");
    const rugPath = getBaselinePath("npx", ["tsx", "src/dummy-server-rug-pull.ts"]);
    const content = await readFile(rugPath, "utf-8");
    assert.ok(content.includes("attacker") || content.includes("Ignore"));
  });
  it("same tools with args changed -> outcome B with warning", async () => {
    const args1 = ["tsx", "src/dummy-server.ts", "pkg@1.0.0", testSuffix + "_pkg"];
    requestCount = 0;
    const r1 = await runCli(["approve", "--accept", "npx", ...args1]);
    assert.equal(r1.code, 0);
    const args2 = ["tsx", "src/dummy-server.ts", "pkg@1.0.1", testSuffix + "_pkg"];
    const r2 = await runCli(["approve", "npx", ...args2]);
    assert.equal(r2.code, 1);
    assert.ok(r2.stderr.includes("related") || r2.stderr.includes("WARNING") || r2.stderr.includes("No exact baseline"));
    requestCount = 0;
    const r3 = await runCli(["approve", "--accept", "npx", ...args2]);
    assert.equal(r3.code, 0);
    const { getBaselinePath } = await import("../src/baseline.js");
    const p1 = getBaselinePath("npx", args1);
    const p2 = getBaselinePath("npx", args2);
    assert.ok(existsSync(p1), "old file should not be deleted");
    assert.ok(existsSync(p2), "new file should exist");
    const newRaw = JSON.parse(await readFile(p2, "utf-8"));
    assert.ok(newRaw.previousKey, "new baseline should have previousKey");
    await rm(p1, { force: true });
    await rm(p2, { force: true });
  });
  it("--name with changed args -> launch command changed finding", async () => {
    const alias = "__test_cli_name";
    const p = join("baselines", `${alias}.json`);
    try { await rm(p, { force: true }); } catch {}
    const r1 = await runCli(["approve", "--accept", "--name", alias, "npx", "tsx", "src/dummy-server.ts", "arg1"]);
    assert.equal(r1.code, 0);
    const r2 = await runCli(["approve", "--name", alias, "npx", "tsx", "src/dummy-server.ts", "arg2"]);
    assert.ok(r2.stderr.includes("launch command changed since approval"));
    assert.equal(r2.code, 0);
    await rm(p, { force: true });
  });
  it("unrelated server -> outcome C first approval", async () => {
    const uniq = testSuffix + "_unrelated";
    const argsUniq = ["tsx", "src/dummy-server-extra-field.ts", uniq];
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", argsUniq);
    try { await rm(p, { force: true }); } catch {}
    requestCount = 0;
    const r = await runCli(["approve", "--accept", "npx", ...argsUniq]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Baseline saved") || r.stderr.includes("Baseline saved"));
    assert.ok(r.stderr.includes("Reviewer:") || r.stderr.includes("reviewed"), `should have reviewer summary: ${r.stderr}`);
    await rm(p, { force: true });
  });
  it("check never writes", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", dummyArgs);
    const beforeStat = await stat(p);
    const beforeContent = await readFile(p, "utf-8");
    requestCount = 0;
    const r = await runCli(["check", "npx", ...dummyArgs]);
    assert.equal(r.code, 0);
    assert.equal(requestCount, 0, "check with no diff should make zero requests");
    const afterStat = await stat(p);
    const afterContent = await readFile(p, "utf-8");
    assert.equal(beforeContent, afterContent);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    const uniqCheck = testSuffix + "_check_nowrite";
    const argsCheck = ["tsx", "src/dummy-server-extra-field.ts", uniqCheck];
    const pCheck = getBaselinePath("npx", argsCheck);
    try { await rm(pCheck, { force: true }); } catch {}
    const r2 = await runCli(["check", "npx", ...argsCheck]);
    assert.equal(r2.code, 2);
    assert.ok(!existsSync(pCheck));
  });

  it("poisoned dummy first approve non-TTY no --accept -> exit 1 no baseline", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", ["tsx", "src/dummy-server-poisoned.ts"]);
    try { await rm(p, { force: true }); } catch {}
    requestCount = 0;
    const r = await runCli(["approve", "npx", "tsx", "src/dummy-server-poisoned.ts"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("flagged") || r.stderr.includes("SUSPICIOUS"));
    assert.ok(r.stderr.includes("Not a TTY and --accept not passed: not saving baseline (reviewer flagged"));
    assert.ok(!existsSync(p), "baseline should not be written");
    assert.ok(requestCount > 0);
  });
  it("poisoned dummy with --accept -> exit 0 baseline written WARNING", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", ["tsx", "src/dummy-server-poisoned.ts"]);
    try { await rm(p, { force: true }); } catch {}
    requestCount = 0;
    const r = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-poisoned.ts"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("WARNING") && r.stderr.includes("flagged"));
    assert.ok(existsSync(p));
    assert.ok(requestCount > 0);
    await rm(p, { force: true });
  });
  it("rug-pull check after flip -> exit 1 with [REVIEW] SUSPICIOUS", async () => {
    try { await rm("baselines/31beea1d546d1c70.json", { force: true }); } catch {}
    try { await rm("baselines/fbc0f37e15e9bd89.json", { force: true }); } catch {}
    const { getBaselinePath } = await import("../src/baseline.js");
    const rugPath = getBaselinePath("npx", ["tsx", "src/dummy-server-rug-pull.ts"]);
    requestCount = 0;
    const r1 = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    if (r1.code !== 0) console.error("approve r1 failed", r1.stdout, r1.stderr);
    assert.equal(r1.code, 0);
    requestCount = 0;
    const r2 = await runCli(["check", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    if (r2.code !== 1) console.error("check r2 failed", r2.stdout, r2.stderr, "requestCount", requestCount);
    assert.equal(r2.code, 1);
    assert.ok(r2.stderr.includes("SUSPICIOUS") && r2.stderr.includes("attacker.example"), `check should have flagged: ${r2.stderr}`);
    assert.ok(requestCount > 0);
    await rm(rugPath, { force: true });
    try { await rm("src/dummy-server-rug-pull.state.json", { force: true }); } catch {}
  });
  it("check benign change -> exit 0 Baseline NOT updated", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", ["tsx", "src/dummy-server-benign-change.ts"]);
    try { await rm(p, { force: true }); } catch {}
    const r1 = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-benign-change.ts"]);
    assert.equal(r1.code, 0);
    const beforeBytes = await readFile(p, "utf-8");
    const beforeStat = await stat(p);
    await new Promise((r) => setTimeout(r, 50));
    requestCount = 0;
    const r2 = await runCli(["check", "npx", "tsx", "src/dummy-server-benign-change.ts"]);
    assert.equal(r2.code, 0);
    assert.ok(r2.stderr.includes("Baseline NOT updated"));
    assert.ok(r2.stderr.includes("Reviewer:") || r2.stderr.includes("reviewed"));
    const afterBytes = await readFile(p, "utf-8");
    assert.equal(beforeBytes, afterBytes);
    const afterStat = await stat(p);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    await rm(p, { force: true });
  });
  it("fake returns 500 -> approve exit 2 with nothing written, check with diff exit 2", async () => {
    const argsPoison = ["tsx", "src/dummy-server-poisoned.ts", testSuffix + "_500_a"];
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", argsPoison);
    try { await rm(p, { force: true }); } catch {}
    shouldReturn500 = true;
    requestCount = 0;
    const r = await runCli(["approve", "--accept", "npx", ...argsPoison]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("Error:") && r.stderr.includes("500"));
    assert.ok(!existsSync(p));
    shouldReturn500 = false;
    const argsBenign = ["tsx", "src/dummy-server-benign-change.ts"];
    const p2 = getBaselinePath("npx", argsBenign);
    try { await rm(p2, { force: true }); } catch {}
    const r1 = await runCli(["approve", "--accept", "npx", ...argsBenign]);
    assert.equal(r1.code, 0);
    shouldReturn500 = true;
    requestCount = 0;
    const r2 = await runCli(["check", "npx", ...argsBenign]);
    assert.equal(r2.code, 2);
    assert.ok(r2.stderr.includes("Error:"));
    shouldReturn500 = false;
    await rm(p2, { force: true });
  });
  it("BASETEN_API_KEY unset: check with no diff -> exit 0, approve new server -> exit 2", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", dummyArgs);
    const r1 = await runCli(["check", "npx", ...dummyArgs], { BASETEN_API_KEY: undefined });
    assert.equal(r1.code, 0, `check with no diff and no key should exit 0, got ${r1.code} ${r1.stderr}`);
    const uniq = testSuffix + "_nokey_" + Date.now();
    const argsUniq = ["tsx", "src/dummy-server-unique.ts", uniq];
    const p2 = getBaselinePath("npx", argsUniq);
    try { await rm(p2, { force: true }); } catch {}
    const r2 = await runCli(["approve", "--accept", "npx", ...argsUniq], { BASETEN_API_KEY: undefined });
    assert.equal(r2.code, 2);
    assert.ok(r2.stderr.includes("BASETEN_API_KEY") && r2.stderr.includes("not set"));
    assert.ok(!existsSync(p2));
  });
  it("no-subcommand listing exits 0 and stderr does not contain __EXIT__", async () => {
    const r = await runCli(["npx", "tsx", "src/dummy-server.ts", testSuffix + "_listing"]);
    assert.equal(r.code, 0, `listing should exit 0, got ${r.code} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stderr.includes("__EXIT"), `stderr should not contain __EXIT, got ${r.stderr}`);
    assert.ok(!r.stderr.includes("__EXIT_0__") && !r.stderr.includes("__EXIT_2__"));
  });
});
