#!/usr/bin/env node
import { fetchToolDefinitions } from "./client.js";
import { validateTools } from "./validate.js";
import { hashTool, aggregateHash } from "./canonicalize.js";
import { getBaselinePath, readBaseline, writeBaselineAtomic, findRelatedBaselines, checkIdentity } from "./baseline.js";
import { diffTools, formatDiff } from "./diff.js";
import { createInterface } from "node:readline";
import { reviewTools } from "./review-runner.js";
import { ReviewerError } from "./reviewer.js";

function printUsageAndExit(): never {
  console.error(`Usage: npx tsx src/cli.ts [--timeout <ms>] [--name <id>] [--accept] [--allow-invalid] [approve|check] <command> [args...]`);
  process.exit(2);
}
function parseArgs(argv: string[]): { command: string; args: string[]; timeoutMs: number; subcommand?: "approve"|"check"; baselineName?: string; accept: boolean; allowInvalid: boolean } {
  let timeoutMs: number|undefined; let baselineName: string|undefined; let accept=false; let allowInvalid=false; let filtered: string[]=[];
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if (arg==="--timeout") { const v=argv[i+1]; if(!v||v.startsWith("-")) printUsageAndExit(); const p=Number(v); if(!Number.isFinite(p)||p<=0) {console.error(`Error: invalid --timeout value "${v}"`);process.exit(2);} timeoutMs=p;i++; }
    else if (arg.startsWith("--timeout=")) { const v=arg.slice("--timeout=".length); const p=Number(v); if(!Number.isFinite(p)||p<=0) {console.error(`Error: invalid --timeout value "${v}"`);process.exit(2);} timeoutMs=p; }
    else if (arg==="--name"||arg==="--as"||arg==="--id") { const v=argv[i+1]; if(!v||v.startsWith("-")) printUsageAndExit(); baselineName=v;i++; }
    else if (arg.startsWith("--name=")) { baselineName=arg.slice("--name=".length); if(!baselineName) printUsageAndExit(); }
    else if (arg.startsWith("--as=")) { baselineName=arg.slice("--as=".length); if(!baselineName) printUsageAndExit(); }
    else if (arg==="--accept") accept=true;
    else if (arg==="--allow-invalid") allowInvalid=true;
    else if (arg==="--") { filtered.push(...argv.slice(i+1)); break; }
    else filtered.push(arg);
  }
  let subcommand: "approve"|"check"|undefined;
  if (filtered[0]==="approve"||filtered[0]==="check") { subcommand=filtered[0] as "approve"|"check"; filtered=filtered.slice(1); }
  if (filtered.length===0) { console.error("Error: no command provided to spawn MCP server"); printUsageAndExit(); }
  if (timeoutMs===undefined) { const envVal=process.env.MCP_TRUST_CHECK_TIMEOUT??process.env.MCP_TIMEOUT; if(envVal){const p=Number(envVal); if(Number.isFinite(p)&&p>0) timeoutMs=p; else console.error(`Warning: ignoring invalid env timeout "${envVal}" - using default`);} }
  if (timeoutMs===undefined) timeoutMs=10000;
  return { command: filtered[0], args: filtered.slice(1), timeoutMs, subcommand, baselineName, accept, allowInvalid };
}
function printFindings(findings: Array<{toolName:string;fieldPath:string;severity:string;code:string;message:string}>): void {
  for (const f of findings) { const sev=f.severity==="error"?"ERROR":"WARN"; console.error(`[${sev}] ${f.toolName} :: ${f.fieldPath} :: ${f.code} :: ${f.message}`); }
}
function printProtocolViolations(result: {protocolViolations:string[];protocolViolationCount:number}): void {
  const pv=result.protocolViolations; if(pv&&pv.length>0){ const n=result.protocolViolationCount??pv.length; console.error(`Warning: Server wrote ${n} non-JSON line(s) to stdout (spec violation), first: "${pv[0]}"`); for(let i=1;i<pv.length;i++) console.error(`  violation ${i+1}: "${pv[i]}"`); }
}
async function askConfirmation(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl=createInterface({input:process.stdin,output:process.stdout});
  const answer: string=await new Promise((resolve)=>{ rl.question(prompt,(ans)=>{rl.close(); resolve(ans);});});
  return answer.trim().toLowerCase()==="y"||answer.trim().toLowerCase()==="yes";
}

async function doExit(code: number): Promise<never> {
  process.exitCode = code;
  // Give Node a tick to clean up fetch/AbortController handles on Windows (avoid UV_HANDLE_CLOSING crash)
  await new Promise<void>((r) => setTimeout(r, 50));
  throw Object.assign(new Error(`__EXIT_${code}__`), { __exitCode: code });
}

function getToolName(t: Record<string, unknown>): string {
  const n = (t as any).name;
  return typeof n === "string" ? n : "<unknown>";
}

async function runReviewIfNeeded(toolsToReview: Record<string, unknown>[]): Promise<{ reviewed: number; flagged: Array<{ name: string; suspicious: boolean; reason: string }> }> {
  if (toolsToReview.length === 0) {
    return { reviewed: 0, flagged: [] };
  }
  try {
    const results = await reviewTools(toolsToReview);
    const flagged = results.filter((r) => r.suspicious);
    for (const f of flagged) {
      console.error(`[REVIEW] ${f.name} :: SUSPICIOUS :: ${f.reason}`);
    }
    console.error(`Reviewer: ${results.length} tool(s) reviewed, ${flagged.length} flagged (advisory, not a guarantee)`);
    return { reviewed: results.length, flagged };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`Error: ${msg}`);
    await doExit(2);
    throw new Error("__EXIT__");
  }
}

function selectToolsForReview(curRaw: Record<string, unknown>[], diff: { added: string[]; changed: Array<{ name: string }>; removed: string[] }): Record<string, unknown>[] {
  const names = new Set<string>([...diff.added, ...diff.changed.map((c) => c.name)]);
  if (names.size === 0) return [];
  return curRaw.filter((t) => names.has(getToolName(t)));
}
async function main(): Promise<void> {
  const { command, args, timeoutMs, subcommand, baselineName, accept, allowInvalid } = parseArgs(process.argv.slice(2));
  if (!subcommand) {
    try {
      const result=await fetchToolDefinitions(command,args,{timeoutMs});
      const vi=result.protocolVersion?` (protocol version: ${result.protocolVersion})`:"";
      console.error(`Lifecycle: ${result.lifecycle}${vi}`);
      printProtocolViolations(result);
      if (result.tools.length===0) console.log("No tools found."); else { console.log(`Found ${result.tools.length} tool(s):`); for(const t of result.tools){ console.log(`- ${(t as Record<string,unknown>).name}: ${(t as Record<string,unknown>).description??"(no description)"}`);} }
    } catch(err:unknown){ console.error(`Error: ${(err as Error)?.message??String(err)}`); await doExit(2); }
    await doExit(0);
  }
  let baselinePath: string|undefined; try{ baselinePath=getBaselinePath(command,args,{name:baselineName}); console.error(`[mcp-trust-check] baseline: ${baselinePath} ${baselineName?`(alias: ${baselineName})`:`(auto hash of command)`}`);}catch{}
  let fetchResult!: Awaited<ReturnType<typeof fetchToolDefinitions>>;
  try{ fetchResult=await fetchToolDefinitions(command,args,{timeoutMs}); } catch(err:unknown){ console.error(`Error: ${(err as Error)?.message??String(err)}`); await doExit(2); }
  const vi2=fetchResult.protocolVersion?` (protocol version: ${fetchResult.protocolVersion})`:""; console.error(`Lifecycle: ${fetchResult.lifecycle}${vi2}`); printProtocolViolations(fetchResult);
  const validation=validateTools(fetchResult.tools as unknown[]);
  if(validation.findings.length>0) printFindings(validation.findings as unknown as Array<{toolName:string;fieldPath:string;severity:string;code:string;message:string}>);
  const hasValidationErrors=validation.findings.some(f=>f.severity==="error");
  const perToolHashes=(fetchResult.tools as unknown[]).map(t=>{const n=(t as Record<string,unknown>).name; return {name:typeof n==="string"?n:"<unknown>",hash:hashTool(t),definition:t as Record<string,unknown>};});
  const currentToolNames=perToolHashes.map(p=>p.name);
  const aggHash=aggregateHash(perToolHashes.map(p=>({name:p.name,hash:p.hash})));
  const buildBaseline=(previousKey?:string)=>({schemaVersion:1,savedAt:new Date().toISOString(),command,args,lifecycle:fetchResult.lifecycle,protocolVersion:fetchResult.protocolVersion,aggregateHash:aggHash,previousKey,tools:perToolHashes.map(p=>({name:p.name,hash:p.hash,definition:p.definition}))});
  if (subcommand==="approve") {
    if(hasValidationErrors&&!allowInvalid){ console.error(`Validation failed with ${validation.findings.filter(f=>f.severity==="error").length} error(s). Not saving baseline. Use --allow-invalid to override.`); await doExit(1); }
    if(hasValidationErrors&&allowInvalid) console.error(`WARNING: --allow-invalid set, continuing despite validation errors. This is NOT recommended.`);
    let exactBaseline: import("./baseline.js").BaselineFile|null=null; let readError: Error|null=null;
    if(baselinePath){ try{ exactBaseline=await readBaseline(baselinePath);} catch(e){ readError=e as Error; } }
    if(readError){ console.error(`Error: ${readError.message}`); await doExit(2); }
    if(exactBaseline){
      const identityMsg=checkIdentity(exactBaseline,command,args); if(identityMsg) console.error(`[identity] ${identityMsg}`);
      const baseRaw=exactBaseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
      const diff=diffTools(baseRaw,curRaw); const hasDiff=diff.added.length>0||diff.removed.length>0||diff.changed.length>0;
      if(!hasDiff&&!hasValidationErrors){ console.log("already approved, unchanged"); if(identityMsg) console.error(`Note: ${identityMsg} (does not block)`); await doExit(0); }
      console.error("Differences detected vs baseline:"); console.error(formatDiff(diff)); if(identityMsg) console.error(identityMsg);
      const toolsToReviewExact = selectToolsForReview(curRaw, diff);
      const { flagged: flaggedExact } = await runReviewIfNeeded(toolsToReviewExact);
      const flaggedCountExact = flaggedExact.length;
      const suffixExact = flaggedCountExact > 0 ? ` (reviewer flagged ${flaggedCountExact} tool(s))` : "";
      let confirmed=accept; if(!confirmed){ if(process.stdin.isTTY) confirmed=await askConfirmation(`Replace baseline ${baselinePath}? [y/N]${suffixExact} `); else { if(flaggedCountExact>0) console.error(`Not a TTY and --accept not passed: not saving baseline (reviewer flagged ${flaggedCountExact} tool(s)).`); else console.error("Not a TTY and --accept not passed: not overwriting baseline. Run with --accept to confirm."); await doExit(1); } }
      if(flaggedCountExact>0 && accept) console.error(`WARNING: --accept given: saving baseline despite ${flaggedCountExact} flagged tool(s).`);
      if(confirmed){ const data=buildBaseline(); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.error(`Baseline updated at ${baselinePath}`); await doExit(0); } else { console.error("Baseline not updated (confirmation declined)."); await doExit(1); }
    } else {
      const {related,warnings}=await findRelatedBaselines(currentToolNames,{excludePath:baselinePath}); for(const w of warnings) console.error(w);
      if(related.length>0){
        const maxOverlap=Math.max(...related.map(r=>r.overlap)); const best=related.filter(r=>r.overlap===maxOverlap); const bestOne=best[0];
        console.error(`WARNING: No exact baseline for this command, but found related baseline(s) with overlap >= 0.5:`); for(const r of related) console.error(`  - ${r.fileName} overlap=${r.overlap.toFixed(2)} common=${r.commonNames.join(",")}`);
        const baseRaw=bestOne.baseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
        const diff=diffTools(baseRaw,curRaw); console.error(`Diff vs best match (${bestOne.fileName}):`); console.error(formatDiff(diff)); if(best.length>1) console.error(`Ties for best match (${best.length} baselines with overlap ${maxOverlap.toFixed(2)}): ${best.map(b=>b.fileName).join(", ")}`);
        const toolsToReviewRelated = selectToolsForReview(curRaw, diff);
        const { flagged: flaggedRelated } = await runReviewIfNeeded(toolsToReviewRelated);
        const flaggedCountRelated = flaggedRelated.length;
        const suffixRelated = flaggedCountRelated > 0 ? ` (reviewer flagged ${flaggedCountRelated} tool(s))` : "";
        let confirmed=accept; if(!confirmed){ if(process.stdin.isTTY) confirmed=await askConfirmation(`Save as new baseline ${baselinePath} with previousKey=${bestOne.fileName}? [y/N]${suffixRelated} `); else { if(flaggedCountRelated>0) console.error(`Not a TTY and --accept not passed: not saving baseline (reviewer flagged ${flaggedCountRelated} tool(s)).`); else console.error("Not a TTY and --accept not passed: not saving new baseline. Run with --accept to confirm."); await doExit(1); } }
        if(flaggedCountRelated>0 && accept) console.error(`WARNING: --accept given: saving baseline despite ${flaggedCountRelated} flagged tool(s).`);
        if(confirmed){ const data=buildBaseline(bestOne.fileName); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.error(`New baseline saved at ${baselinePath} (previousKey=${bestOne.fileName}, old file not deleted)`); await doExit(0); } else { console.error("New baseline not saved."); await doExit(1); }
      } else {
        const curRawAll = fetchResult.tools as unknown as Record<string, unknown>[];
        const toolsToReviewAll = curRawAll;
        const { flagged: flaggedAll } = await runReviewIfNeeded(toolsToReviewAll);
        const flaggedCountAll = flaggedAll.length;
        if(flaggedCountAll>0){
          let confirmedAll=accept; if(!confirmedAll){ if(process.stdin.isTTY) confirmedAll=await askConfirmation(`Save new baseline ${baselinePath} despite ${flaggedCountAll} flagged tool(s)? [y/N] `); else { console.error(`Not a TTY and --accept not passed: not saving baseline (reviewer flagged ${flaggedCountAll} tool(s)).`); await doExit(1); } }
          if(flaggedCountAll>0 && accept) console.error(`WARNING: --accept given: saving baseline despite ${flaggedCountAll} flagged tool(s).`);
          if(confirmedAll){ const data=buildBaseline(); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.log(`Baseline saved at ${baselinePath}`); await doExit(0); } else { console.error("New baseline not saved."); await doExit(1); }
        } else {
          const data=buildBaseline(); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.log(`Baseline saved at ${baselinePath}`); await doExit(0);
        }
      }
    }
  } else if (subcommand==="check") {
    let exactBaseline: import("./baseline.js").BaselineFile|null=null; let readError: Error|null=null;
    if(baselinePath){ try{ exactBaseline=await readBaseline(baselinePath);} catch(e){ readError=e as Error; } }
    if(readError){ console.error(`Error: ${readError.message}`); await doExit(2); }
    if(exactBaseline){
      const identityMsg=checkIdentity(exactBaseline,command,args); if(identityMsg) console.error(`[identity] ${identityMsg}`);
      const baseRaw=exactBaseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
      const diff=diffTools(baseRaw,curRaw); const hasDiff=diff.added.length>0||diff.removed.length>0||diff.changed.length>0;
      if(hasValidationErrors){
        console.error(`Validation errors: ${validation.findings.filter(f=>f.severity==="error").length} error(s)`);
        await doExit(1);
      }
      if(!hasDiff){
        console.log("check passed: unchanged and valid");
        await doExit(0);
      }
      // hasDiff and no validation errors -> review added+changed
      console.error("Differences detected vs baseline:");
      console.error(formatDiff(diff));
      const toolsToReviewCheck = selectToolsForReview(curRaw, diff);
      if(toolsToReviewCheck.length===0){
        // only removed tools, nothing to review
        await doExit(0);
      }
      const { flagged: flaggedCheck } = await runReviewIfNeeded(toolsToReviewCheck);
      if(flaggedCheck.length>0){
        await doExit(1);
      } else {
        console.error("Reviewer found nothing suspicious (advisory, not a guarantee). Baseline NOT updated; run approve to accept this change.");
        await doExit(0);
      }
    } else {
      const {related,warnings}=await findRelatedBaselines(currentToolNames,{excludePath:baselinePath}); for(const w of warnings) console.error(w);
      if(related.length>0){
        const maxOverlap=Math.max(...related.map(r=>r.overlap)); const best=related.filter(r=>r.overlap===maxOverlap); const bestOne=best[0];
        console.error(`WARNING: No exact baseline, but related baseline(s) found with overlap >= 0.5:`); for(const r of related) console.error(`  - ${r.fileName} overlap=${r.overlap.toFixed(2)} common=${r.commonNames.join(",")}`);
        const baseRaw=bestOne.baseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
        const diff=diffTools(baseRaw,curRaw); console.error(`Diff vs best match (${bestOne.fileName}):`); console.error(formatDiff(diff)); if(best.length>1) console.error(`Ties: ${best.map(b=>b.fileName).join(", ")}`);
        await doExit(1);
      } else { console.error(`No baseline found for this server. Run: approve ${command} ${args.join(" ")}`); await doExit(2); }
    }
  }
}
main().catch(async (err)=>{
  const msg = (err as Error)?.message ?? String(err);
  if (msg.startsWith("__EXIT_")) {
    // Graceful exit via exitCode, do not print
    return;
  }
  console.error(`Error: ${msg}`);
  process.exitCode = 2;
  await new Promise<void>((r) => setTimeout(r, 50));
});
