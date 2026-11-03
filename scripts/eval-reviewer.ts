import fs from "node:fs";
import path from "node:path";
import { reviewTool, ReviewerError } from "../src/reviewer.js";
import { validateTools } from "../src/validate.js";
export function evaluatePairs(cases: Array<{pair_id:string|null, label:string, correct:boolean, contested?:boolean, reason?:string, why?:string, runs?:any[]}>){
  const groups:Record<string, typeof cases> = {};
  for(const c of cases) if(c.pair_id){ if(!groups[c.pair_id]) groups[c.pair_id]=[]; groups[c.pair_id].push(c); }
  let both=0, onlyMal=0, onlyBen=0, neither=0; const wrong:any[]=[];
  for(const [pid, arr] of Object.entries(groups)){
    const mal=(arr as any).find((x:any)=>x.label==="malicious"); const ben=(arr as any).find((x:any)=>x.label==="benign");
    const malOk=mal&&mal.correct; const benOk=ben&&ben.correct;
    if(malOk&&benOk) both++; else if(malOk&&!benOk) onlyMal++; else if(!malOk&&benOk) onlyBen++; else neither++;
    if(!malOk||!benOk){
      const malReason=mal? (mal.reason ?? mal.runs?.[0]?.reason ?? "") : "";
      const benReason=ben? (ben.reason ?? ben.runs?.[0]?.reason ?? "") : "";
      wrong.push({pair_id:pid, malCorrect:malOk, benCorrect:benOk, malReason, benReason, malWhy:mal?mal.why:"", benWhy:ben?ben.why:""});
    }
  }
  return {total:Object.keys(groups).length, bothCorrect:both, onlyMalicious:onlyMal, onlyBenign:onlyBen, neither, wrongPairs:wrong};
}

function parseRuns(): number { const idx=process.argv.indexOf("--runs"); if(idx!==-1){const v=process.argv[idx+1];const n=Number(v);if(!Number.isInteger(n)||n<=0){console.error(`Invalid --runs value: ${v}`);process.exit(2);}return n;} return 3; }
function parseSet(): string { const idx=process.argv.indexOf("--set"); if(idx!==-1){const v=process.argv[idx+1];if(!["base","extra","paired","all"].includes(v)){console.error(`Invalid --set value: ${v} (expected base|extra|paired|all)`);process.exit(2);}return v;} return "all"; }
async function main(){
if(!process.env.BASETEN_API_KEY){console.error("BASETEN_API_KEY is not set. Set it in your .env or environment.");process.exit(2);}
const runs=parseRuns();const set=parseSet();
let cases:any[]=[];
function loadSet(file:string,setName:string){
  const p=path.resolve(file);
  if(!fs.existsSync(p)){ if(set==="all") return; if(setName==="extra"){console.error(`Missing ${p}`);process.exit(2);} return; }
  const raw=fs.readFileSync(p,"utf8"); const arr=JSON.parse(raw);
  for(const c of arr) cases.push({...c,_set:setName});
}
if(set==="base"||set==="all") loadSet("scripts/eval/cases.json","base");
if(set==="extra"||set==="all") loadSet("scripts/eval/cases-extra.json","extra");
if(set==="paired"||set==="all") loadSet("scripts/eval/cases-paired.json","paired");
if(cases.length===0){console.error("No cases loaded");process.exit(2);}
console.log(`Eval reviewer: ${cases.length} cases (set=${set}), ${runs} runs each, concurrency 2`);
const concurrency=2;
type Task={caseIdx:number;runIdx:number;tool:Record<string,unknown>};
const tasks:Task[]=[]; for(let ci=0;ci<cases.length;ci++) for(let r=0;r<runs;r++) tasks.push({caseIdx:ci,runIdx:r,tool:cases[ci].tool});
type RunResult={verdict:"flagged"|"not_flagged"|"error";reason:string|null;errorMsg:string|null;latencyMs:number};
const results:RunResult[][]=cases.map(()=>Array(runs).fill(null) as unknown as RunResult[]);
const latencies:number[]=[]; let next=0;
async function worker(){while(true){const idx=next++; if(idx>=tasks.length) return; const t=tasks[idx]; const start=Date.now(); try{const res=await reviewTool(t.tool); const latency=Date.now()-start; latencies.push(latency); results[t.caseIdx][t.runIdx]={verdict:res.suspicious?"flagged":"not_flagged",reason:res.reason,errorMsg:null,latencyMs:latency};}catch(e){const latency=Date.now()-start; latencies.push(latency); const msg=e instanceof ReviewerError?e.message:(e as Error).message; results[t.caseIdx][t.runIdx]={verdict:"error",reason:null,errorMsg:msg,latencyMs:latency};}}}
const workers=Array.from({length:concurrency},()=>worker()); await Promise.all(workers);
type Row={id:string;label:string;difficulty:string;category:string;set:string;verdicts:string;majority:string;correct:string;validateErrors:number;validateFlagged:boolean};
const rows:Row[]=[]; const disagreed:string[]=[];
let perTP=0,perFP=0,perFN=0,perTN=0,perErr=0; let majTP=0,majFP=0,majFN=0,majTN=0,majErr=0;
const perByCat:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={}; const majByCat:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={};
const perBySet:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={base:{tp:0,fp:0,fn:0,tn:0,err:0},extra:{tp:0,fp:0,fn:0,tn:0,err:0},paired:{tp:0,fp:0,fn:0,tn:0,err:0},all:{tp:0,fp:0,fn:0,tn:0,err:0}};
const majBySet:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={base:{tp:0,fp:0,fn:0,tn:0,err:0},extra:{tp:0,fp:0,fn:0,tn:0,err:0},paired:{tp:0,fp:0,fn:0,tn:0,err:0},all:{tp:0,fp:0,fn:0,tn:0,err:0}};
const perByDiff:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={easy_benign:{tp:0,fp:0,fn:0,tn:0,err:0},easy_malicious:{tp:0,fp:0,fn:0,tn:0,err:0},hard_benign:{tp:0,fp:0,fn:0,tn:0,err:0},hard_malicious:{tp:0,fp:0,fn:0,tn:0,err:0}};
const perByFamily:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={}; const majByFamily:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={}; const contestedCases:any[]=[];
const majByDiff:Record<string,{tp:number;fp:number;fn:number;tn:number;err:number}>={easy_benign:{tp:0,fp:0,fn:0,tn:0,err:0},easy_malicious:{tp:0,fp:0,fn:0,tn:0,err:0},hard_benign:{tp:0,fp:0,fn:0,tn:0,err:0},hard_malicious:{tp:0,fp:0,fn:0,tn:0,err:0}};
const fullResults:any[]=[]; const notSeen:any[]=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i]; const runRes=results[i];
 const verdictLetters=runRes.map(r=>r.verdict==="flagged"?"T":r.verdict==="not_flagged"?"F":"E").join(" ");
 const cntT=runRes.filter(r=>r.verdict==="flagged").length, cntF=runRes.filter(r=>r.verdict==="not_flagged").length, cntE=runRes.filter(r=>r.verdict==="error").length;
 let majority:"flagged"|"not_flagged"|"error"; if(cntT>runs/2) majority="flagged"; else if(cntF>runs/2) majority="not_flagged"; else if(cntE>runs/2) majority="error"; else { if(cntT>=cntF && cntT>=cntE) majority="flagged"; else if(cntF>=cntT && cntF>=cntE) majority="not_flagged"; else majority="error"; }
 const majorityLetter=majority==="flagged"?"T":majority==="not_flagged"?"F":"E";
 const isCorrect=(c.label==="malicious"&&majority==="flagged")||(c.label==="benign"&&majority==="not_flagged");
 const correctStr=isCorrect?"yes":"no";
 const v=validateTools([c.tool]); const errCount=v.findings.filter(f=>f.severity==="error").length; const flaggedByValidator=errCount>0;
 const cat=c.category||"unknown"; if(!perByCat[cat]) perByCat[cat]={tp:0,fp:0,fn:0,tn:0,err:0}; if(!majByCat[cat]) majByCat[cat]={tp:0,fp:0,fn:0,tn:0,err:0};
 const family=c.family||"none"; if(!perByFamily[family]) perByFamily[family]={tp:0,fp:0,fn:0,tn:0,err:0}; if(!majByFamily[family]) majByFamily[family]={tp:0,fp:0,fn:0,tn:0,err:0};
 if(c.contested) contestedCases.push(c);
 rows.push({id:c.id,label:c.label,difficulty:c.difficulty,category:cat,set:c._set,verdicts:verdictLetters,majority:majorityLetter,correct:correctStr,validateErrors:errCount,validateFlagged:flaggedByValidator});
 if(new Set(runRes.map(r=>r.verdict)).size>1) disagreed.push(c.id);
 if(!c.contested){ for(const r of runRes){
   const key=`${c.difficulty}_${c.label}` as keyof typeof perByDiff;
   if(r.verdict==="error"){perErr++; perByDiff[key].err++; perByCat[cat].err++; perByFamily[family].err++; perBySet[c._set].err++; perBySet.all.err++;}
   else if(c.label==="malicious"&&r.verdict==="flagged"){perTP++; perByDiff[key].tp++; perByCat[cat].tp++; perByFamily[family].tp++; perBySet[c._set].tp++; perBySet.all.tp++;}
   else if(c.label==="malicious"&&r.verdict==="not_flagged"){perFN++; perByDiff[key].fn++; perByCat[cat].fn++; perByFamily[family].fn++; perBySet[c._set].fn++; perBySet.all.fn++;}
   else if(c.label==="benign"&&r.verdict==="flagged"){perFP++; perByDiff[key].fp++; perByCat[cat].fp++; perByFamily[family].fp++; perBySet[c._set].fp++; perBySet.all.fp++;}
   else if(c.label==="benign"&&r.verdict==="not_flagged"){perTN++; perByDiff[key].tn++; perByCat[cat].tn++; perByFamily[family].tn++; perBySet[c._set].tn++; perBySet.all.tn++;}
 }
 const majKey=`${c.difficulty}_${c.label}` as keyof typeof majByDiff;
 if(majority==="error"){majErr++; majByDiff[majKey].err++; majByCat[cat].err++; majBySet[c._set].err++; majBySet.all.err++;}
 else if(c.label==="malicious"&&majority==="flagged"){majTP++; majByDiff[majKey].tp++; majByCat[cat].tp++; majByFamily[family].tp++; majBySet[c._set].tp++; majBySet.all.tp++;}
 else if(c.label==="malicious"&&majority==="not_flagged"){majFN++; majByDiff[majKey].fn++; majByCat[cat].fn++; majByFamily[family].fn++; majBySet[c._set].fn++; majBySet.all.fn++;}
 else if(c.label==="benign"&&majority==="flagged"){majFP++; majByDiff[majKey].fp++; majByCat[cat].fp++; majByFamily[family].fp++; majBySet[c._set].fp++; majBySet.all.fp++;}
 else if(c.label==="benign"&&majority==="not_flagged"){majTN++; majByDiff[majKey].tn++; majByCat[cat].tn++; majByFamily[family].tn++; majBySet[c._set].tn++; majBySet.all.tn++;}
 }
 const entry={id:c.id,pair_id:c.pair_id??null,label:c.label,difficulty:c.difficulty,category:cat,family:c.family??"none",inspired_by:c.inspired_by,contested:!!c.contested,why:c.why,model_sees_payload:c.model_sees_payload,set:c._set,tool:c.tool,validateErrorCount:errCount,validateFlagged:flaggedByValidator,validateFindings:v.findings,runs:runRes.map(r=>({verdict:r.verdict,reason:r.reason,error:r.errorMsg,latencyMs:r.latencyMs})),majority:majorityLetter,correct:isCorrect,verdicts:verdictLetters};
 fullResults.push(entry);
 if(c.model_sees_payload===false) notSeen.push(entry);
}
console.log(`Eval reviewer: ${cases.length} cases (set=${set}), ${runs} runs each, concurrency ${concurrency}`);
console.log(""); console.log(["id","label","difficulty","category","set","verdicts("+runs+")","majority","correct","validateErrs","validatorFlagged"].join("\t"));
for(const r of rows) console.log([r.id,r.label,r.difficulty,r.category,r.set,r.verdicts,r.majority,r.correct,String(r.validateErrors),r.validateFlagged?"yes":"no"].join("\t"));
console.log(""); console.log("Summary per-run:"); console.log(`  TP=${perTP} FP=${perFP} FN=${perFN} TN=${perTN} errors=${perErr} total=${cases.length*runs}`);
console.log("Summary by majority:"); console.log(`  TP=${majTP} FP=${majFP} FN=${majFN} TN=${majTN} errors=${majErr} total=${cases.length}`);
function rate(fp:number,tn:number){const d=fp+tn;return d? (fp/d).toFixed(3):"n/a"} function det(tp:number,fn:number){const d=tp+fn;return d? (tp/d).toFixed(3):"n/a"}
console.log(""); console.log("Rates per-run:"); console.log(`  benign easy FPR: ${rate(perByDiff.easy_benign.fp,perByDiff.easy_benign.tn)} (${perByDiff.easy_benign.fp}/${perByDiff.easy_benign.fp+perByDiff.easy_benign.tn})`); console.log(`  benign hard FPR: ${rate(perByDiff.hard_benign.fp,perByDiff.hard_benign.tn)} (${perByDiff.hard_benign.fp}/${perByDiff.hard_benign.fp+perByDiff.hard_benign.tn})`); console.log(`  malicious easy detection: ${det(perByDiff.easy_malicious.tp,perByDiff.easy_malicious.fn)} (${perByDiff.easy_malicious.tp}/${perByDiff.easy_malicious.tp+perByDiff.easy_malicious.fn})`); console.log(`  malicious hard detection: ${det(perByDiff.hard_malicious.tp,perByDiff.hard_malicious.fn)} (${perByDiff.hard_malicious.tp}/${perByDiff.hard_malicious.tp+perByDiff.hard_malicious.fn})`);
console.log("Rates by majority:"); console.log(`  benign easy FPR: ${rate(majByDiff.easy_benign.fp,majByDiff.easy_benign.tn)} (${majByDiff.easy_benign.fp}/${majByDiff.easy_benign.fp+majByDiff.easy_benign.tn})`); console.log(`  benign hard FPR: ${rate(majByDiff.hard_benign.fp,majByDiff.hard_benign.tn)} (${majByDiff.hard_benign.fp}/${majByDiff.hard_benign.fp+majByDiff.hard_benign.tn})`); console.log(`  malicious easy detection: ${det(majByDiff.easy_malicious.tp,majByDiff.easy_malicious.fn)} (${majByDiff.easy_malicious.tp}/${majByDiff.easy_malicious.tp+majByDiff.easy_malicious.fn})`); console.log(`  malicious hard detection: ${det(majByDiff.hard_malicious.tp,majByDiff.hard_malicious.fn)} (${majByDiff.hard_malicious.tp}/${majByDiff.hard_malicious.tp+majByDiff.hard_malicious.fn})`);
console.log(""); console.log("Per-set summary (by majority):"); for(const s of ["base","extra","paired","all"]) if(majBySet[s].tp+ majBySet[s].fp+ majBySet[s].fn+ majBySet[s].tn+ majBySet[s].err>0) console.log(`  ${s}: TP=${majBySet[s].tp} FP=${majBySet[s].fp} FN=${majBySet[s].fn} TN=${majBySet[s].tn} errors=${majBySet[s].err}`);
console.log("Per-category summary (by majority):"); for(const [cat,cts] of Object.entries(majByCat)) console.log(`  ${cat}: TP=${cts.tp} FP=${cts.fp} FN=${cts.fn} TN=${cts.tn} errors=${cts.err}`);
if(notSeen.length){console.log(""); console.log(`Model_sees_payload=false cases (${notSeen.length}) - excluded from accuracy: ${notSeen.map((c:any)=>c.id).join(", ")}`); for(const c of notSeen) console.log(`  ${c.id} validatorFlagged=${c.validateFlagged?"yes":"no"}`);} else {console.log(""); console.log("Model_sees_payload=false cases: none - all payloads were in sent fields");}
const mean=latencies.length?(latencies.reduce((a,b)=>a+b,0)/latencies.length).toFixed(1):"n/a"; const max=latencies.length?Math.max(...latencies):0;
console.log(""); console.log("Per-family summary (by majority):"); for(const [fam,cts] of Object.entries(majByFamily)) console.log(`  ${fam}: TP=${cts.tp} FP=${cts.fp} FN=${cts.fn} TN=${cts.tn} errors=${cts.err}`);
console.log(""); console.log(`Contested cases (${contestedCases.length}) - excluded from headline rates:`); for(const cc of contestedCases) console.log(`  ${cc.id} contested=${cc.contested} label=${cc.label} family=${cc.family} why=${cc.why}`);
const allPairs = fullResults.filter(fr=>fr.pair_id);
const nonContestedPairs = allPairs.filter(fr=>!fr.contested);
const contestedPairsOnly = allPairs.filter(fr=>fr.contested);
const pairResult = evaluatePairs(nonContestedPairs);
const pairResultContested = evaluatePairs(contestedPairsOnly);
let pairBothCorrect=pairResult.bothCorrect, pairOnlyMalicious=pairResult.onlyMalicious, pairOnlyBenign=pairResult.onlyBenign, pairNeither=pairResult.neither; const wrongPairs=pairResult.wrongPairs;
let pairBothCorrectCont=pairResultContested.bothCorrect, pairOnlyMaliciousCont=pairResultContested.onlyMalicious, pairOnlyBenignCont=pairResultContested.onlyBenign, pairNeitherCont=pairResultContested.neither; const wrongPairsCont=pairResultContested.wrongPairs;
console.log(""); console.log(`Pair accuracy (non-contested): both correct ${pairBothCorrect}/${pairResult.total} (${pairResult.total? (pairBothCorrect/pairResult.total*100).toFixed(1):0}%)`);
console.log(`  only malicious caught: ${pairOnlyMalicious}, only benign cleared: ${pairOnlyBenign}, neither: ${pairNeither}`);
if(wrongPairs.length){ console.log("Wrong pairs (non-contested):"); for(const wp of wrongPairs) console.log(`  ${wp.pair_id}: malCorrect=${wp.malCorrect} benCorrect=${wp.benCorrect} malWhy=${wp.malWhy} benWhy=${wp.benWhy} malReason=${wp.malReason} benReason=${wp.benReason}`); } else console.log("Wrong pairs (non-contested): none");
console.log(`Pair accuracy (contested): both correct ${pairBothCorrectCont}/${pairResultContested.total} (${pairResultContested.total? (pairBothCorrectCont/pairResultContested.total*100).toFixed(1):0}%)`);
console.log(`  only malicious caught: ${pairOnlyMaliciousCont}, only benign cleared: ${pairOnlyBenignCont}, neither: ${pairNeitherCont}`);
if(wrongPairsCont.length){ console.log("Wrong pairs (contested):"); for(const wp of wrongPairsCont) console.log(`  ${wp.pair_id}: malCorrect=${wp.malCorrect} benCorrect=${wp.benCorrect} malWhy=${wp.malWhy} benWhy=${wp.benWhy} malReason=${wp.malReason} benReason=${wp.benReason}`); } else console.log("Wrong pairs (contested): none");
console.log(""); console.log(`Latency per call: mean=${mean}ms max=${max}ms`);
if(disagreed.length) console.log(`Disagreed cases (${disagreed.length}): ${disagreed.join(", ")}`); else console.log("Disagreed cases: none");
console.log(""); console.log("Malicious cases validator check (already caught by deterministic validator):");
for(const r of rows.filter(r=>r.label==="malicious")) console.log(`  ${r.id}: validatorFlagged=${r.validateFlagged?"yes":"no"} errs=${r.validateErrors}`);
const outDir=path.resolve("eval-results"); fs.mkdirSync(outDir,{recursive:true}); const outPath=path.join(outDir,"latest.json");
const out={generatedAt:new Date().toISOString(),runs,concurrency,set,cases:fullResults,summary:{perRun:{TP:perTP,FP:perFP,FN:perFN,TN:perTN,errors:perErr},byMajority:{TP:majTP,FP:majFP,FN:majFN,TN:majTN,errors:majErr},perRunByDifficulty:perByDiff,byMajorityByDifficulty:majByDiff,perRunByCategory:perByCat,byMajorityByCategory:majByCat,perRunBySet:perBySet,byMajorityBySet:majBySet,perRunByFamily:perByFamily,byMajorityByFamily:majByFamily,latency:{meanMs:Number(mean),maxMs:max,all:latencies},disagreed,notSeenIds:notSeen.map((c:any)=>c.id),contested:contestedCases.map((c:any)=>c.id),pairAccuracy:{bothCorrect:pairBothCorrect,onlyMalicious:pairOnlyMalicious,onlyBenign:pairOnlyBenign,neither:pairNeither,total:pairResult.total},wrongPairs, pairAccuracyContested:{bothCorrect:pairBothCorrectCont,onlyMalicious:pairOnlyMaliciousCont,onlyBenign:pairOnlyBenignCont,neither:pairNeitherCont,total:pairResultContested.total},wrongPairsContested:wrongPairsCont}};
fs.writeFileSync(outPath,JSON.stringify(out,null,2)); console.log(`Wrote ${outPath}`);
}
if(process.argv[1] && process.argv[1].replace(/\\/g,'/').endsWith('scripts/eval-reviewer.ts')) main().catch(e=>{console.error(`Error: ${(e as Error).message}`);process.exit(2);});
