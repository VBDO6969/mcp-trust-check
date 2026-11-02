import fs from "node:fs";
import path from "node:path";
import { reviewTool, ReviewerError } from "../src/reviewer.js";
import { validateTools } from "../src/validate.js";

function parseRuns(): number {
  const idx = process.argv.indexOf("--runs");
  if (idx !== -1) {
    const v = process.argv[idx + 1];
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`Invalid --runs value: ${v}`);
      process.exit(2);
    }
    return n;
  }
  return 3;
}

async function main() {
  if (!process.env.BASETEN_API_KEY) {
    console.error("BASETEN_API_KEY is not set. Set it in your .env or environment.");
    process.exit(2);
  }
  const runs = parseRuns();
  const casesPath = path.resolve("scripts/eval/cases.json");
  let raw: string;
  try {
    raw = fs.readFileSync(casesPath, "utf8");
  } catch (e) {
    console.error(`Failed to read cases.json at ${casesPath}: ${(e as Error).message}`);
    process.exit(2);
  }
  let cases: Array<{ id: string; label: string; difficulty: string; why: string; tool: Record<string, unknown> }>;
  try {
    cases = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to parse cases.json: ${(e as Error).message}`);
    process.exit(2);
  }
  const concurrency = 2;
  type Task = { caseIdx: number; runIdx: number; tool: Record<string, unknown> };
  const tasks: Task[] = [];
  for (let ci = 0; ci < cases.length; ci++) {
    for (let r = 0; r < runs; r++) tasks.push({ caseIdx: ci, runIdx: r, tool: cases[ci].tool });
  }
  type RunResult = { verdict: "flagged" | "not_flagged" | "error"; reason: string | null; errorMsg: string | null; latencyMs: number };
  const results: RunResult[][] = cases.map(() => Array(runs).fill(null) as unknown as RunResult[]);
  const latencies: number[] = [];
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      const t = tasks[idx];
      const start = Date.now();
      try {
        const res = await reviewTool(t.tool);
        const latency = Date.now() - start;
        latencies.push(latency);
        results[t.caseIdx][t.runIdx] = { verdict: res.suspicious ? "flagged" : "not_flagged", reason: res.reason, errorMsg: null, latencyMs: latency };
      } catch (e) {
        const latency = Date.now() - start;
        latencies.push(latency);
        const msg = e instanceof ReviewerError ? e.message : (e as Error).message;
        results[t.caseIdx][t.runIdx] = { verdict: "error", reason: null, errorMsg: msg, latencyMs: latency };
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  type Row = { id: string; label: string; difficulty: string; verdicts: string; majority: string; correct: string; validateErrors: number };
  const rows: Row[] = [];
  const disagreed: string[] = [];
  let perTP = 0, perFP = 0, perFN = 0, perTN = 0, perErr = 0;
  let majTP = 0, majFP = 0, majFN = 0, majTN = 0, majErr = 0;
  const perByDiff: Record<string, { tp: number; fp: number; fn: number; tn: number; err: number }> = {
    easy_benign: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    easy_malicious: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    hard_benign: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    hard_malicious: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
  };
  const majByDiff: Record<string, { tp: number; fp: number; fn: number; tn: number; err: number }> = {
    easy_benign: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    easy_malicious: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    hard_benign: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
    hard_malicious: { tp: 0, fp: 0, fn: 0, tn: 0, err: 0 },
  };
  const fullResults: any[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const runRes = results[i];
    const verdictLetters = runRes.map(r => (r.verdict === "flagged" ? "T" : r.verdict === "not_flagged" ? "F" : "E")).join(" ");
    const cntT = runRes.filter(r => r.verdict === "flagged").length;
    const cntF = runRes.filter(r => r.verdict === "not_flagged").length;
    const cntE = runRes.filter(r => r.verdict === "error").length;
    let majority: "flagged" | "not_flagged" | "error";
    if (cntT > runs / 2) majority = "flagged";
    else if (cntF > runs / 2) majority = "not_flagged";
    else if (cntE > runs / 2) majority = "error";
    else {
      if (cntT >= cntF && cntT >= cntE) majority = "flagged";
      else if (cntF >= cntT && cntF >= cntE) majority = "not_flagged";
      else majority = "error";
    }
    const majorityLetter = majority === "flagged" ? "T" : majority === "not_flagged" ? "F" : "E";
    const isCorrect = (c.label === "malicious" && majority === "flagged") || (c.label === "benign" && majority === "not_flagged");
    const correctStr = isCorrect ? "yes" : "no";
    const v = validateTools([c.tool]);
    const errCount = v.findings.filter(f => f.severity === "error").length;
    rows.push({ id: c.id, label: c.label, difficulty: c.difficulty, verdicts: verdictLetters, majority: majorityLetter, correct: correctStr, validateErrors: errCount });
    const uniq = new Set(runRes.map(r => r.verdict));
    if (uniq.size > 1) disagreed.push(c.id);
    for (const r of runRes) {
      const key = `${c.difficulty}_${c.label}` as keyof typeof perByDiff;
      if (r.verdict === "error") { perErr++; perByDiff[key].err++; }
      else if (c.label === "malicious" && r.verdict === "flagged") { perTP++; perByDiff[key].tp++; }
      else if (c.label === "malicious" && r.verdict === "not_flagged") { perFN++; perByDiff[key].fn++; }
      else if (c.label === "benign" && r.verdict === "flagged") { perFP++; perByDiff[key].fp++; }
      else if (c.label === "benign" && r.verdict === "not_flagged") { perTN++; perByDiff[key].tn++; }
    }
    const majKey = `${c.difficulty}_${c.label}` as keyof typeof majByDiff;
    if (majority === "error") { majErr++; majByDiff[majKey].err++; }
    else if (c.label === "malicious" && majority === "flagged") { majTP++; majByDiff[majKey].tp++; }
    else if (c.label === "malicious" && majority === "not_flagged") { majFN++; majByDiff[majKey].fn++; }
    else if (c.label === "benign" && majority === "flagged") { majFP++; majByDiff[majKey].fp++; }
    else if (c.label === "benign" && majority === "not_flagged") { majTN++; majByDiff[majKey].tn++; }
    fullResults.push({
      id: c.id,
      label: c.label,
      difficulty: c.difficulty,
      why: c.why,
      tool: c.tool,
      validateErrorCount: errCount,
      validateFindings: v.findings,
      runs: runRes.map(r => ({ verdict: r.verdict, reason: r.reason, error: r.errorMsg, latencyMs: r.latencyMs })),
      majority: majorityLetter,
      correct: isCorrect,
      verdicts: verdictLetters,
    });
  }
  console.log(`Eval reviewer: ${cases.length} cases, ${runs} runs each, concurrency ${concurrency}`);
  console.log("");
  const header = ["id", "label", "difficulty", `verdicts(${runs})`, "majority", "correct", "validateErrs"].join("\t");
  console.log(header);
  for (const r of rows) {
    console.log([r.id, r.label, r.difficulty, r.verdicts, r.majority, r.correct, String(r.validateErrors)].join("\t"));
  }
  console.log("");
  console.log("Summary per-run:");
  console.log(`  TP=${perTP} FP=${perFP} FN=${perFN} TN=${perTN} errors=${perErr} total=${cases.length * runs}`);
  console.log("Summary by majority:");
  console.log(`  TP=${majTP} FP=${majFP} FN=${majFN} TN=${majTN} errors=${majErr} total=${cases.length}`);
  function rate(fp: number, tn: number) { const d = fp + tn; return d ? (fp / d).toFixed(3) : "n/a"; }
  function det(tp: number, fn: number) { const d = tp + fn; return d ? (tp / d).toFixed(3) : "n/a"; }
  console.log("");
  console.log("Rates per-run:");
  console.log(`  benign easy FPR: ${rate(perByDiff.easy_benign.fp, perByDiff.easy_benign.tn)} (${perByDiff.easy_benign.fp}/${perByDiff.easy_benign.fp + perByDiff.easy_benign.tn})`);
  console.log(`  benign hard FPR: ${rate(perByDiff.hard_benign.fp, perByDiff.hard_benign.tn)} (${perByDiff.hard_benign.fp}/${perByDiff.hard_benign.fp + perByDiff.hard_benign.tn})`);
  console.log(`  malicious easy detection: ${det(perByDiff.easy_malicious.tp, perByDiff.easy_malicious.fn)} (${perByDiff.easy_malicious.tp}/${perByDiff.easy_malicious.tp + perByDiff.easy_malicious.fn})`);
  console.log(`  malicious hard detection: ${det(perByDiff.hard_malicious.tp, perByDiff.hard_malicious.fn)} (${perByDiff.hard_malicious.tp}/${perByDiff.hard_malicious.tp + perByDiff.hard_malicious.fn})`);
  console.log("Rates by majority:");
  console.log(`  benign easy FPR: ${rate(majByDiff.easy_benign.fp, majByDiff.easy_benign.tn)} (${majByDiff.easy_benign.fp}/${majByDiff.easy_benign.fp + majByDiff.easy_benign.tn})`);
  console.log(`  benign hard FPR: ${rate(majByDiff.hard_benign.fp, majByDiff.hard_benign.tn)} (${majByDiff.hard_benign.fp}/${majByDiff.hard_benign.fp + majByDiff.hard_benign.tn})`);
  console.log(`  malicious easy detection: ${det(majByDiff.easy_malicious.tp, majByDiff.easy_malicious.fn)} (${majByDiff.easy_malicious.tp}/${majByDiff.easy_malicious.tp + majByDiff.easy_malicious.fn})`);
  console.log(`  malicious hard detection: ${det(majByDiff.hard_malicious.tp, majByDiff.hard_malicious.fn)} (${majByDiff.hard_malicious.tp}/${majByDiff.hard_malicious.tp + majByDiff.hard_malicious.fn})`);
  const mean = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : "n/a";
  const max = latencies.length ? Math.max(...latencies) : 0;
  console.log("");
  console.log(`Latency per call: mean=${mean}ms max=${max}ms`);
  if (disagreed.length) {
    console.log(`Disagreed cases (${disagreed.length}): ${disagreed.join(", ")}`);
  } else {
    console.log("Disagreed cases: none");
  }
  const outDir = path.resolve("eval-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "latest.json");
  const out = {
    generatedAt: new Date().toISOString(),
    runs,
    concurrency,
    cases: fullResults,
    summary: {
      perRun: { TP: perTP, FP: perFP, FN: perFN, TN: perTN, errors: perErr },
      byMajority: { TP: majTP, FP: majFP, FN: majFN, TN: majTN, errors: majErr },
      perRunByDifficulty: perByDiff,
      byMajorityByDifficulty: majByDiff,
      latency: { meanMs: Number(mean), maxMs: max, all: latencies },
      disagreed,
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
}
main().catch(e => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(2);
});


