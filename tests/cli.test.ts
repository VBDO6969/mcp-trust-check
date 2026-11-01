import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/cli.ts", ...args], { stdio: ["pipe", "pipe", "pipe"], shell: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}
async function getBaselineFiles(): Promise<string[]> {
  try { const files = await readdir("baselines"); return files.filter((f) => f.endsWith(".json")); } catch { return []; }
}

describe("CLI approve/check", () => {
  const testSuffix = `__cli_test_${Date.now()}`;
  const dummyArgs = ["tsx", "src/dummy-server.ts", testSuffix];
  after(async () => {
    try {
      const files = await readdir("baselines");
      for (const f of files) {
        const p = join("baselines", f);
        try { const raw = await readFile(p, "utf-8"); if (raw.includes(testSuffix)) await rm(p, { force: true }); } catch {}
      }
    } catch {}
    try { await rm("src/dummy-server-rug-pull.state.json", { force: true }); } catch {}
    try { await rm("baselines/__test_cli_name.json", { force: true }); } catch {}
    try { await rm("baselines/31beea1d546d1c70.json", { force: true }); } catch {}
    try { await rm("baselines/fbc0f37e15e9bd89.json", { force: true }); } catch {}
  });
  it("approve twice unchanged (exit 0, file untouched)", async () => {
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
    const r2 = await runCli(["approve", "npx", ...dummyArgs]);
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.includes("already approved, unchanged") || r2.stderr.includes("already approved"));
    const stat2 = await stat(baselinePath);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs);
  });
  it("rug-pull without --accept in non-TTY should exit 1 and not overwrite", async () => {
    try { await rm("src/dummy-server-rug-pull.state.json", { force: true }); } catch {}
    try { await rm("baselines/31beea1d546d1c70.json", { force: true }); } catch {}
    try { await rm("baselines/fbc0f37e15e9bd89.json", { force: true }); } catch {}
    const r1 = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r1.code, 0);
    const { getBaselinePath } = await import("../src/baseline.js");
    const rugPath = getBaselinePath("npx", ["tsx", "src/dummy-server-rug-pull.ts"]);
    const beforeContent = await readFile(rugPath, "utf-8");
    assert.ok(beforeContent.includes("Get current weather for a city") && !beforeContent.includes("attacker"));
    const statBefore = await stat(rugPath);
    const r2 = await runCli(["approve", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r2.code, 1);
    assert.ok(r2.stderr.includes("Differences") || r2.stderr.includes("diff"));
    const afterContent = await readFile(rugPath, "utf-8");
    assert.equal(beforeContent, afterContent);
    const statAfter = await stat(rugPath);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
  });
  it("rug-pull with --accept should replace and show diff", async () => {
    const r = await runCli(["approve", "--accept", "npx", "tsx", "src/dummy-server-rug-pull.ts"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("Baseline updated") || r.stderr.includes("Baseline"));
    const { getBaselinePath } = await import("../src/baseline.js");
    const rugPath = getBaselinePath("npx", ["tsx", "src/dummy-server-rug-pull.ts"]);
    const content = await readFile(rugPath, "utf-8");
    assert.ok(content.includes("attacker") || content.includes("Ignore"));
  });
  it("same tools with args changed -> outcome B with warning", async () => {
    const args1 = ["tsx", "src/dummy-server.ts", "pkg@1.0.0", testSuffix + "_pkg"];
    const r1 = await runCli(["approve", "--accept", "npx", ...args1]);
    assert.equal(r1.code, 0);
    const args2 = ["tsx", "src/dummy-server.ts", "pkg@1.0.1", testSuffix + "_pkg"];
    const r2 = await runCli(["approve", "npx", ...args2]);
    assert.equal(r2.code, 1);
    assert.ok(r2.stderr.includes("related") || r2.stderr.includes("WARNING") || r2.stderr.includes("No exact baseline"));
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
    const r = await runCli(["approve", "--accept", "npx", ...argsUniq]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Baseline saved") || r.stderr.includes("Baseline saved"));
    assert.ok(r.stdout.includes("LLM review and human confirmation for flagged tools are not implemented yet.") || r.stderr.includes("LLM review"));
    await rm(p, { force: true });
  });
  it("check never writes", async () => {
    const { getBaselinePath } = await import("../src/baseline.js");
    const p = getBaselinePath("npx", dummyArgs);
    const beforeStat = await stat(p);
    const beforeContent = await readFile(p, "utf-8");
    const r = await runCli(["check", "npx", ...dummyArgs]);
    assert.equal(r.code, 0);
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

});
