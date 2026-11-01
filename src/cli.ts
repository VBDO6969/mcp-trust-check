#!/usr/bin/env node
import { fetchToolDefinitions } from "./client.js";
import { validateTools } from "./validate.js";
import { hashTool, aggregateHash } from "./canonicalize.js";
import { getBaselinePath, readBaseline, writeBaselineAtomic, findRelatedBaselines, checkIdentity } from "./baseline.js";
import { diffTools, formatDiff } from "./diff.js";
import { createInterface } from "node:readline";

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
async function main(): Promise<void> {
  const { command, args, timeoutMs, subcommand, baselineName, accept, allowInvalid } = parseArgs(process.argv.slice(2));
  if (!subcommand) {
    try {
      const result=await fetchToolDefinitions(command,args,{timeoutMs});
      const vi=result.protocolVersion?` (protocol version: ${result.protocolVersion})`:"";
      console.error(`Lifecycle: ${result.lifecycle}${vi}`);
      printProtocolViolations(result);
      if (result.tools.length===0) console.log("No tools found."); else { console.log(`Found ${result.tools.length} tool(s):`); for(const t of result.tools){ console.log(`- ${(t as Record<string,unknown>).name}: ${(t as Record<string,unknown>).description??"(no description)"}`);} }
      process.exit(0);
    } catch(err:unknown){ console.error(`Error: ${(err as Error)?.message??String(err)}`); process.exit(2); }
  }
  let baselinePath: string|undefined; try{ baselinePath=getBaselinePath(command,args,{name:baselineName}); console.error(`[mcp-trust-check] baseline: ${baselinePath} ${baselineName?`(alias: ${baselineName})`:`(auto hash of command)`}`);}catch{}
  let fetchResult: Awaited<ReturnType<typeof fetchToolDefinitions>>;
  try{ fetchResult=await fetchToolDefinitions(command,args,{timeoutMs}); } catch(err:unknown){ console.error(`Error: ${(err as Error)?.message??String(err)}`); process.exit(2); }
  const vi2=fetchResult.protocolVersion?` (protocol version: ${fetchResult.protocolVersion})`:""; console.error(`Lifecycle: ${fetchResult.lifecycle}${vi2}`); printProtocolViolations(fetchResult);
  const validation=validateTools(fetchResult.tools as unknown[]);
  if(validation.findings.length>0) printFindings(validation.findings as unknown as Array<{toolName:string;fieldPath:string;severity:string;code:string;message:string}>);
  const hasValidationErrors=validation.findings.some(f=>f.severity==="error");
  const perToolHashes=(fetchResult.tools as unknown[]).map(t=>{const n=(t as Record<string,unknown>).name; return {name:typeof n==="string"?n:"<unknown>",hash:hashTool(t),definition:t as Record<string,unknown>};});
  const currentToolNames=perToolHashes.map(p=>p.name);
  const aggHash=aggregateHash(perToolHashes.map(p=>({name:p.name,hash:p.hash})));
  const buildBaseline=(previousKey?:string)=>({schemaVersion:1,savedAt:new Date().toISOString(),command,args,lifecycle:fetchResult.lifecycle,protocolVersion:fetchResult.protocolVersion,aggregateHash:aggHash,previousKey,tools:perToolHashes.map(p=>({name:p.name,hash:p.hash,definition:p.definition}))});
  if (subcommand==="approve") {
    if(hasValidationErrors&&!allowInvalid){ console.error(`Validation failed with ${validation.findings.filter(f=>f.severity==="error").length} error(s). Not saving baseline. Use --allow-invalid to override.`); process.exit(1); }
    if(hasValidationErrors&&allowInvalid) console.error(`WARNING: --allow-invalid set, continuing despite validation errors. This is NOT recommended.`);
    let exactBaseline: import("./baseline.js").BaselineFile|null=null; let readError: Error|null=null;
    if(baselinePath){ try{ exactBaseline=await readBaseline(baselinePath);} catch(e){ readError=e as Error; } }
    if(readError){ console.error(`Error: ${readError.message}`); process.exit(2); }
    if(exactBaseline){
      const identityMsg=checkIdentity(exactBaseline,command,args); if(identityMsg) console.error(`[identity] ${identityMsg}`);
      const baseRaw=exactBaseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
      const diff=diffTools(baseRaw,curRaw); const hasDiff=diff.added.length>0||diff.removed.length>0||diff.changed.length>0;
      if(!hasDiff&&!hasValidationErrors){ console.log("already approved, unchanged"); if(identityMsg) console.error(`Note: ${identityMsg} (does not block)`); console.error("LLM review and sandbox are not implemented yet."); process.exit(0); }
      console.error("Differences detected vs baseline:"); console.error(formatDiff(diff)); if(identityMsg) console.error(identityMsg);
      let confirmed=accept; if(!confirmed){ if(process.stdin.isTTY) confirmed=await askConfirmation(`Replace baseline ${baselinePath}? [y/N] `); else { console.error("Not a TTY and --accept not passed: not overwriting baseline. Run with --accept to confirm."); process.exit(1); } }
      if(confirmed){ const data=buildBaseline(); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.error(`Baseline updated at ${baselinePath}`); console.error("LLM review and human confirmation for flagged tools are not implemented yet."); process.exit(0); } else { console.error("Baseline not updated (confirmation declined)."); process.exit(1); }
    } else {
      const {related,warnings}=await findRelatedBaselines(currentToolNames,{excludePath:baselinePath}); for(const w of warnings) console.error(w);
      if(related.length>0){
        const maxOverlap=Math.max(...related.map(r=>r.overlap)); const best=related.filter(r=>r.overlap===maxOverlap); const bestOne=best[0];
        console.error(`WARNING: No exact baseline for this command, but found related baseline(s) with overlap >= 0.5:`); for(const r of related) console.error(`  - ${r.fileName} overlap=${r.overlap.toFixed(2)} common=${r.commonNames.join(",")}`);
        const baseRaw=bestOne.baseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
        const diff=diffTools(baseRaw,curRaw); console.error(`Diff vs best match (${bestOne.fileName}):`); console.error(formatDiff(diff)); if(best.length>1) console.error(`Ties for best match (${best.length} baselines with overlap ${maxOverlap.toFixed(2)}): ${best.map(b=>b.fileName).join(", ")}`);
        let confirmed=accept; if(!confirmed){ if(process.stdin.isTTY) confirmed=await askConfirmation(`Save as new baseline ${baselinePath} with previousKey=${bestOne.fileName}? [y/N] `); else { console.error("Not a TTY and --accept not passed: not saving new baseline. Run with --accept to confirm."); process.exit(1); } }
        if(confirmed){ const data=buildBaseline(bestOne.fileName); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.error(`New baseline saved at ${baselinePath} (previousKey=${bestOne.fileName}, old file not deleted)`); console.error("LLM review and human confirmation for flagged tools are not implemented yet."); process.exit(0); } else { console.error("New baseline not saved."); process.exit(1); }
      } else { const data=buildBaseline(); await writeBaselineAtomic(baselinePath!, data as import("./baseline.js").BaselineFile); console.log(`Baseline saved at ${baselinePath}`); console.log("LLM review and human confirmation for flagged tools are not implemented yet."); process.exit(0); }
    }
  } else if (subcommand==="check") {
    let exactBaseline: import("./baseline.js").BaselineFile|null=null; let readError: Error|null=null;
    if(baselinePath){ try{ exactBaseline=await readBaseline(baselinePath);} catch(e){ readError=e as Error; } }
    if(readError){ console.error(`Error: ${readError.message}`); process.exit(2); }
    if(exactBaseline){
      const identityMsg=checkIdentity(exactBaseline,command,args); if(identityMsg) console.error(`[identity] ${identityMsg}`);
      const baseRaw=exactBaseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
      const diff=diffTools(baseRaw,curRaw); const hasDiff=diff.added.length>0||diff.removed.length>0||diff.changed.length>0;
      if(hasDiff){ console.error("Differences detected vs baseline:"); console.error(formatDiff(diff)); }
      if(hasValidationErrors) console.error(`Validation errors: ${validation.findings.filter(f=>f.severity==="error").length} error(s) (provisional until Layer 2)`);
      if(hasDiff||hasValidationErrors){ console.error("LLM review and sandbox are not implemented yet."); process.exit(1); } else { console.log("check passed: unchanged and valid"); console.error("LLM review and sandbox are not implemented yet."); process.exit(0); }
    } else {
      const {related,warnings}=await findRelatedBaselines(currentToolNames,{excludePath:baselinePath}); for(const w of warnings) console.error(w);
      if(related.length>0){
        const maxOverlap=Math.max(...related.map(r=>r.overlap)); const best=related.filter(r=>r.overlap===maxOverlap); const bestOne=best[0];
        console.error(`WARNING: No exact baseline, but related baseline(s) found with overlap >= 0.5:`); for(const r of related) console.error(`  - ${r.fileName} overlap=${r.overlap.toFixed(2)} common=${r.commonNames.join(",")}`);
        const baseRaw=bestOne.baseline.tools.map(t=>t.definition as Record<string,unknown>); const curRaw=fetchResult.tools as unknown as Record<string,unknown>[];
        const diff=diffTools(baseRaw,curRaw); console.error(`Diff vs best match (${bestOne.fileName}):`); console.error(formatDiff(diff)); if(best.length>1) console.error(`Ties: ${best.map(b=>b.fileName).join(", ")}`);
        console.error("LLM review and sandbox are not implemented yet."); process.exit(1);
      } else { console.error(`No baseline found for this server. Run: approve ${command} ${args.join(" ")}`); console.error("LLM review and sandbox are not implemented yet."); process.exit(2); }
    }
  }
}
main().catch((err)=>{ console.error(`Error: ${(err as Error)?.message??String(err)}`); process.exit(2); });
