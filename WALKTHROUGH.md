# mcp-trust-check â€” Developer Walkthrough for Hackathon Judges

> **You are not the author.** This doc lets any developer who did not write the code explain it honestly in 10 minutes. It covers what the repo *actually does today* (Layer 0), not the roadmap.

---

## 1. What the Project Does and Why (5 sentences)

Sentence 1 â€” Problem: Any MCP server you install can lie to the LLM through the tools it advertises, and the user never sees that lie until damage is done.

Sentence 2 â€” Tool poisoning: A malicious server ships with a tool whose description (or hidden fields like _meta / x_custom_top) already contains prompt-injection instructions from day one.

Sentence 3 â€” Rug pull: A server that looked benign at install later changes a tool's description, inputSchema, or extra fields after the user approved it.

Sentence 4 â€” What this CLI will be: mcp-trust-check is intended as the gate *before* you trust a third-party MCP server â€” locally and later in CI â€” that will fetch tools over stdio, will validate them deterministically, will diff against a per-server baseline, will ask an LLM for an advisory opinion, and (stretch-goal) will reproduce behaviour in a sandbox.

Sentence 5 â€” Why it matters for this demo: It currently enforces real MCP lifecycle (modern `server/discover` 2026-07-28 + legacy `initialize` 2025-11-25) and is *designed* so the first approval will be screened rather than blindly hashed â€” so poisoned-from-day-one tools will not be able to slip through once Layer 1 lands.

---

## 2. What Is Implemented Now vs Planned â€” Per Layer, Honestly

| Layer | Name | Status | Exists TODAY | Planned (not code yet) | Honest gap |
|---|---|---|---|---|---|
| Layer 0 | MCP client | DONE & tested | Spawns server via @modelcontextprotocol/client@2.4.0 stdio; dual lifecycle probe modern then legacy; fetchToolDefinitions loops tools/list with cursor pagination cap 100 (throws on infinite); preserves full raw objects via zod passthrough including _meta/x_custom_top; timeout per-request + outer buffer; stderr piped/tailed; Windows orphan taskkill /t /f; approve/check stubs compute baseline path but still only fetch; exit 0 success 1 error. | â€” | Only layer you can verify. |
| Layer 1 | Validate+Diff+Baseline | Planned â€” helper only | baseline.ts computes per-server path: sha256(command+null+args) -> baselines/<16hex>.json or --name -> baselines/<sanitized>.json. CLI prints path in approve/check but never reads/writes file. | validate.ts shape checks, length cap ~2000, scan every string field for zero-width/bidi/unicode-tag, HTML comments, base64; canonicalize sorted keys + SHA-256 + read/write baselines + diff. | Claiming done would be false. |
| Layer 2 | LLM reviewer | Planned â€” zero code | Spec only in README+PROJECT_CONTEXT. | Call https://inference.baseten.co/v1 model meta-models/muse-spark-open-1026, key BASETEN_API_KEY from env, extract JSON from reasoning, zod-validate, retry; return {suspicious,reason,category} advisory. | No code. |
| Layer 3 | Sandbox verifier | Stretch, may be cut | Nothing. | Docker with fake canary file, generate inputs from inputSchema, observe network/file, verdicts CONFIRMED/NOT_REPRODUCED/INCONCLUSIVE. | May be omitted. |

Bottom line: Layer 0 is real with exhaustive failure-server coverage. Layers 1-3 are design; stubs print [not implemented yet: Layer 1].

---

## 3. File Map â€” Each File, One Line, What It Does and Who Calls It

| File | One-line purpose | Who calls / is called by |
|---|---|---|
| package.json | Manifest: name, SDK deps 2.4.0, zod 4.6.7, scripts (trust-check, check, approve, test variants, build, typecheck), Node>=20. | npm install; every npx tsx run |
| tsconfig.json | TS config: ES2022, NodeNext, strict, rootDir src -> outDir dist. | tsc / tsx |
| PROJECT_CONTEXT.md | Source-of-truth decisions doc: hackathon constraints, approve vs check rationale, 4-layer arch, security rules. | Humans/agents; README summarizes |
| README.md | Public how-to-run: SDK versions, SDK APIs used, timeout precedence, lifecycle, 8 tests with expected output, limitations. | First file judges read |
| .env.example | Template: BASETEN_API_KEY= (only secret name). | Developer copies to .env; Layer 2 will read |
| .gitignore | Excludes node_modules, dist, .env, baselines/, baseline.json, *.log. | Git |
| src/cli.ts | CLI entry + arg parser: --timeout/--timeout=MS, --name/--as/--id, -- separator, approve/check stub, env fallback MCP_TRUST_CHECK_TIMEOUT/MCP_TIMEOUT ->10000, handlers, calls fetchToolDefinitions, prints Lifecycle to stderr and tools to stdout, baseline path + not-implemented notice, exit 0/1/130/143. | User via npx tsx src/cli.ts; imports client.ts+baseline.ts |
| src/client.ts | Core Layer 0: fetchToolDefinitions(command,args,options)->{lifecycle,protocolVersion,tools}; StdioClientTransport+Client, stderr pipe, tries auto then legacy on -32601, loops tools/list via client.request passthrough cap 100, cleanup taskkill, maps errors + stderr tail. | Called by cli.ts and test-*.ts |
| src/baseline.ts | Per-server baseline path: sha256(canonical null-separated) -> baselines/<16hex>.json or alias; getBaselineInfo for display. | Imported dynamically by cli.ts when approve/check |
| src/dummy-server.ts | Modern dummy: serveStdio -> 2 tools get_weather+add_numbers via zod. Golden. | Spawned by tests; npm run dummy/test:cli |
| src/dummy-server-broken.ts | Alias of garbage: plain non-JSON stdout then exit 1 at 300ms. | npm run test:nonjson |
| src/dummy-server-extra-field.ts | Tests preservation via McpServer with _meta x_custom/hidden_instruction. | test-extra-field.ts first half |
| src/dummy-server-legacy.ts | Forces legacy via serveStdio(...,{legacy:serve}) 2 tools. | npm run dummy:legacy |
| src/dummy-server-legacy-only.ts | Raw JSON-RPC legacy-only: rejects server/discover -32601, initialize 2025-11-25, tools/list 2 tools, ping. Proves fallback. | Manual legacy proof |
| src/dummy-server-slow.ts | Alias of timeout: never responds, keepalive. | npm run test:timeout |
| src/failure-servers/exit-immediate.ts | Crash on start: stderr + exit 1, no handshake. | Exit/crash test |
| src/failure-servers/extra-field-raw.ts | Raw server with extra fields: _meta + x_custom_top + x_hidden in tools/list. | test-extra-field second half + test-raw-request |
| src/failure-servers/garbage.ts | Plain non-JSON garbage then exit 300ms (silent skip). | Contrast with garbage-stay-alive |
| src/failure-servers/garbage-stay-alive.ts | Stay-alive garbage: valid JSON but not JSON-RPC not-jsonrpc -> SDK validation error. | Canonical garbage test |
| src/failure-servers/paginated.ts | 5-tool server tool_a..tool_e via McpServer. | test-pagination normal |
| src/failure-servers/pagination-infinite.ts | Infinite cursor trap: always returns nextCursor + tool_page_N. | test-pagination cap |
| src/failure-servers/timeout.ts | Never responds, ignores stdin, keepalive. | Timeout tests |
| src/inspect-client.ts | Dev utility: dumps Client prototype methods, request type, Protocol prototype. | Run manually to discover SDK v2 APIs |
## 4. Data Flow of approve and check as They Work TODAY (not the plan)

Today approve and check are identical â€” both do only Layer 0. Difference is where divergence will happen.

### 4.1 User types

```
PowerShell> npx tsx src/cli.ts [--timeout MS] [--name ALIAS] approve npx tsx src/dummy-server.ts
                   |           |              |       forwarded as command+args to StdioClientTransport
                   |           |              subcommand stub (Layer 0 only)
                   |           optional timeout override
                   tsx loader (no build needed)
```

### 4.2 Step-by-step TODAY (approve, check, and bare npx tsx src/cli.ts <cmd>)

```
1. PowerShell --argv--> cli.ts:parseArgs()
     strips --timeout/--name/-- before remainder
     returns {command, args, timeoutMs, subcommand, baselineName}
     timeout: --timeout flag > MCP_TRUST_CHECK_TIMEOUT/MCP_TIMEOUT env > 10000
     invalid/missing value -> printUsageAndExit() -> exit 1

2. cli.ts --dynamic import--> baseline.ts:getBaselinePath(command,args,{name})
     if subcommand approve|check:
       canonical = command + "\\0" + args.join("\\0")
       hash = sha256(canonical).hex.slice(0,16)
       path = name ? baselines/<sanitized>.json : baselines/<hash>.json
       sanitized = name.replace(/[^a-zA-Z0-9-_]/g,"_").slice(0,64)
       logs to stderr:
         [mcp-trust-check] subcommand: approve|check (Layer 0 only â€” Layer 1 not implemented yet)
         [mcp-trust-check] baseline: <path> (auto hash | alias: <name>)
       NOTE: path computed+printed but NEVER read/written today. No file created.

3. cli.ts registers handlers
     SIGINT -> gracefulExit(130)
     SIGTERM -> gracefulExit(143)
     unhandledRejection -> console.error -> exit 1 (no stack)

4. cli.ts --await--> client.ts:fetchToolDefinitions(command,args,{timeoutMs})
   4a. attempt("auto")  // modern probe first
        transport = new StdioClientTransport({command, args, stderr:"pipe"})
        stderrChunks cap 64 KiB, tail = last 20 lines
        transport.onerror wrapped to capture transportError
        // NEW: stdout violation hook (added after WALKTHROUGH first draft)
        // SDK exposes only stderr+pid; stdout is private _process.stdout and ReadBuffer silently skips SyntaxError.
        // We peek via (transport as any)._process?.stdout and add passive side-channel listener:
        //   split on "\n", try JSON.parse, on SyntaxError => count++ and keep first 3 truncated 200 chars.
        //   violationHookAttached flag; if never attached warnIfHookLost() is appended to timeout/close errors.
        //   Poll every 5ms for _process.stdout; cleared on cleanup().
        client = new Client({name:"mcp-trust-check",version:"1.0.0"},{capabilities:{}, listMaxPages:maxPages, versionNegotiation:{mode:"auto", probe:{timeoutMs,maxRetries:0}}})
        wraps onerror again after connect (Client overwrites it)
        cleanup() defined: Windows taskkill /pid /t /f + CIM fallback then client.close()+transport.close() + clear violation poll
        withTimeout(client.connect(transport,{timeout:timeoutMs}), timeoutMs+2000, "connect (requested ${timeoutMs}ms + 2000ms buffer = ${ms}ms)")
          // actual timeout per phase is requested + buffer: connect +2000, tools/list +1000
          SDK spawns child; if modern sends server/discover via sibling, negotiate; else probe fails
        LooseToolsListResult = z.object({tools:z.array(z.record(z.string(),z.unknown())), nextCursor:z.string().optional()}).passthrough()
          passthrough critical: keeps every unknown field for Layer 1 hashing
        loop pages 0..maxPages-1 (default 100):
          params = cursor ? {cursor} : {}
          result = withTimeout(client.request({method:"tools/list",params}, LooseToolsListResult, {timeout:timeoutMs}), timeoutMs+1000, label)
          if transportError -> throw Server sent invalid JSON-RPC during tools/list... (with violation suffix if any)
          if !result.tools array -> throw Invalid response for tools/list...
          push tools; cursor = result.nextCursor; pages++; break if !cursor
          if pages>=maxPages && cursor -> throw Pagination safety cap exceeded (...pages)...
        finalEra = client.getProtocolEra() -> modern|legacy
        finalVersion = client.getNegotiatedProtocolVersion()
        flushStdoutViolations() // count trailing pending line without newline
        await cleanup()
        return {lifecycle, protocolVersion, tools:FULL raw, protocolViolations, protocolViolationCount}
   4b. on error in attempt("auto"): cleanup(); classify:
          ENOENT/EACCES/spawn/is not recognized/not found/cannot find -> Failed to spawn...
          parse/unexpected token/transportError -> Server produced invalid JSON-RPC...
          closed/exit -> MCP server process exited... â€” Server wrote N non-JSON line(s) to stdout (spec violation), first: "..." if violations>0 (plus hook warning if never attached)
          timed out -> Request timed out after ${ms}ms (${labelDetail})... â€” Server wrote N non-JSON line(s) to stdout (spec violation), first: "..." if violations>0
        append --- server stderr (last 20 lines) --- if present
   4c. outer catch: if msg contains method not found/-32601/discover/unsupported protocol version/era negotiation
        -> return await attempt("legacy") // versionNegotiation:{mode:"legacy"}, same loop with same violation hook else throw

5. cli.ts on success -> stderr+stdout print
     versionInfo = protocolVersion ? " (protocol version: ...)" : ""
     stderr: Lifecycle: modern|legacy{versionInfo}
     stderr: Connected via <lifecycle> flow - negotiated version: ...
     if violations: stderr: Warning: Server wrote N non-JSON line(s) to stdout (spec violation), first: "preview" (+ up to 2 more)
     stdout: No tools found. OR Found N tool(s): + - <name>: <desc> per tool
     if subcommand: stderr baseline path for this server: <path>
                   stderr [not implemented yet: Layer 1] approve would now run validate -> LLM review -> save baseline (or check: validate -> diff -> LLM review -> sandbox)
                   stderr Exit code 0 here means Layer 0 (fetch) succeeded; future Layer 1 will use 0=clean, 1=confirmed/invalid
     exit 0
6. cli.ts on any throw -> stderr Error: <message + violation suffix + stderr tail> -> exit 1
```

### 4.3 How you know it is still Layer 0 (updated for violation hook)

- Baseline path printed (e.g. baselines\\853524f0e79ea788.json) does NOT exist on disk after run â€” dir baselines says not found.
- Lifecycle always to stderr, tools to stdout â€” you can pipe stdout separately.
- approve and check produce byte-identical stdout for same server; only stderr stub lines differ.
- **New:** Plain non-JSON stdout is now *reported* (Warning on success, or `Server wrote N non-JSON line(s) to stdout (spec violation)` on timeout/close) instead of silently skipped as before. The return value now carries `protocolViolations` (first 3 truncated 200) and `protocolViolationCount` for Layer 1, but Layer 1 still does not gate â€” exit 0 today still means â€œfetch + violation observation succeededâ€, not â€œsafeâ€.

### 4.4 Disk / network touched today

Touches: spawn child, read stdout/stderr pipes (now also counting non-JSON stdout lines via side-channel), optionally kill tree, write stdout/stderr, process.exit. Does NOT touch: no file read/write, no network, no LLM, no Docker.
## 5. Table of Every Command I Can Run â€” Windows PowerShell, Output Lines, Exit Codes

All commands assume working dir d:\mcp-trust-check and npm install done. Use PowerShell (not CMD). npx prefixes npm notice lines before your output.

### 5.0 Setup (run once)

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| S1 | npm install | Installs client@2.4.0 server@2.4.0 zod@4.6.7 tsx@4.23 typescript@7. Creates node_modules/. | 0 |
| S2 | npx tsc --noEmit | Type-checks src/*.ts; no output on success = pass. Errors show file:line:col. | 0 ok, 2 type errors |
| S3 | npm run typecheck | Alias of S2. | 0 |
| S4 | npm run build | Compiles src->dist (not required, tsx runs raw TS). | 0 |

### 5.1 Core CLI â€” direct fetch (backward compatible)

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| C1 | npx tsx src/cli.ts npx tsx src/dummy-server.ts | stderr: Lifecycle: modern (protocol version: 2026-07-28) via server/discover; Connected via modern flow. stdout: Found 2 tool(s): - get_weather: Get current weather for a city - add_numbers: Add two numbers together. Golden happy-path. | 0 |
| C2 | npx tsx src/cli.ts --timeout 5000 npx tsx src/dummy-server.ts | Same as C1 but timeoutMs 5000 overrides env/default. No extra line. | 0 |
| C3 | npx tsx src/cli.ts --timeout=5000 npx tsx src/dummy-server.ts | = form of --timeout, identical to C2. | 0 |
| C4 | npx tsx src/cli.ts -- npx tsx src/dummy-server.ts | -- separator: everything after is spawn command even if looks like flag. | 0 |
| C5 | $env:MCP_TRUST_CHECK_TIMEOUT=5000; npx tsx src/cli.ts npx tsx src/dummy-server.ts; Remove-Item Env:\MCP_TRUST_CHECK_TIMEOUT | Env timeout (precedence: --timeout > env >10000). Invalid logs Warning: ignoring invalid env timeout "..." to stderr. | 0 |
| C6 | $env:MCP_TIMEOUT=5000; npx tsx src/cli.ts npx tsx src/dummy-server.ts; Remove-Item Env:\MCP_TIMEOUT | Alias env var MCP_TIMEOUT same as C5. | 0 |
| C7 | npx tsx src/cli.ts | stderr: Error: no command provided... + Usage: ... + Timeout precedence... No stdout. | 1 |
| C8 | npx tsx src/cli.ts --timeout | stderr: Error: --timeout requires a numeric value... + usage. | 1 |
| C9 | npx tsx src/cli.ts --timeout abc npx tsx src/dummy-server.ts | stderr: Error: invalid --timeout value "abc" - must be positive integer. | 1 |
| C10 | npx tsx src/cli.ts --name myServer npx tsx src/dummy-server.ts | Without subcommand, --name parsed but unused (only approve/check use it). Tools same as C1, no baseline line. | 0 |

### 5.2 Gate stubs â€” approve and check (Layer 0 fetch + notice)

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| G1 | npx tsx src/cli.ts approve npx tsx src/dummy-server.ts | stderr L1: [mcp-trust-check] subcommand: approve (Layer 0 only â€” Layer 1 not implemented yet). L2: baseline: baselines\853524f0e79ea788.json (auto hash) hash of npx\0tsx\0src/dummy-server.ts sha256 16hex. L3-4 same Lifecycle+Connected as C1. stdout same tool list. L5: baseline path for this server: baselines\... repeat. L6: [not implemented yet: Layer 1] approve would now run validate -> LLM review -> save baseline + Exit code 0 here means Layer 0 fetch succeeded. | 0 |
| G2 | npx tsx src/cli.ts check npx tsx src/dummy-server.ts | Same as G1 but check + validate -> diff -> LLM review -> sandbox. | 0 |
| G3 | npx tsx src/cli.ts approve --name weather npx tsx src/dummy-server.ts | stderr baseline: baselines\weather.json (alias: weather) sanitized alias not hash. | 0 |
| G4 | npx tsx src/cli.ts approve --as weather npx tsx src/dummy-server.ts | Alias --as same as --name. | 0 |
| G5 | npx tsx src/cli.ts approve --name=weather npx tsx src/dummy-server.ts | = form of alias. | 0 |
| G6 | npx tsx src/cli.ts --timeout 5000 approve npx tsx src/dummy-server.ts | Timeout before subcommand parsed correctly. Lines same as G1. | 0 |
| G7 | npx tsx src/cli.ts check --name weather npx tsx src/dummy-server.ts | Check with alias same as G3 but check notice. | 0 |
| G8 | npm run approve -- npx tsx src/dummy-server.ts | Script alias plus npm notice header. Output same as G1. | 0 |
| G9 | npm run check -- npx tsx src/dummy-server.ts | Script alias for check mirrors G2. | 0 |

### 5.3 npm script shortcuts

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| N1 | npm run test:cli | tsx src/cli.ts -- npx tsx src/dummy-server.ts same as C1 plus npm notice header. | 0 |
| N2 | npm run test:legacy | tsx src/cli.ts -- npx tsx src/dummy-server-legacy.ts (legacy forced via serveStdio {legacy:serve}); Lifecycle may be modern or legacy, tools still 2. For deterministic proof use N2b. | 0 |
| N2b | npx tsx src/cli.ts npx tsx src/dummy-server-legacy-only.ts | Deterministic legacy proof: raw server rejects server/discover -> Lifecycle: legacy (2025-11-25) + Connected via legacy flow. | 0 |
| N3 | npm run test:spawn-fail | tsx src/cli.ts -- does-not-exist-12345 -> stderr Error: Failed to spawn ... + --- server stderr --- + 'does-not-exist-12345' is not recognized... + --- end stderr ---. | 1 |
| N4 | npm run test:timeout | tsx src/cli.ts --timeout 1000 -- npx tsx src/dummy-server-slow.ts -> stderr Error: Request timed out + tail dummy-server-slow: started... | 1 |
| N5 | npm run test:nonjson | tsx src/cli.ts -- npx tsx src/dummy-server-broken.ts plain garbage; now `Error: MCP server process exited â€” Server wrote 3 non-JSON line(s) to stdout (spec violation), first: "THIS IS NOT JSON-RPC - GARBAGE OUTPUT {{{ not json"` (previously silently skipped as Request timed out; now reported via violation hook). | 1 |

### 5.4 Failure-server tests â€” every failure mode

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| F1 | npx tsx src/cli.ts npx tsx src/failure-servers/exit-immediate.ts | stderr: Error: MCP server process exited or closed connection: Connection closed + --- server stderr --- + npm notice + exit-immediate: exiting immediately... + --- end stderr --- | 1 |
| F2 | npx tsx src/cli.ts --timeout 1500 npx tsx src/failure-servers/timeout.ts | stderr: Error: Request timed out after 3500ms (connect (requested 1500ms + 2000ms buffer = 3500ms)) + tail never-responds: started... / received data but ignoring... | 1 |
| F3 | npx tsx src/cli.ts npx tsx src/failure-servers/garbage.ts | Plain non-JSON then exit 300ms; now detected: `Error: MCP server process exited or closed connection: Connection closed â€” Server wrote 3 non-JSON line(s) to stdout (spec violation), first: "THIS IS NOT JSON-RPC - GARBAGE OUTPUT {{{ not json"` + stderr tail. Previously silently skipped, now reported via violation hook. | 1 |
| F4 | npx tsx src/cli.ts npx tsx src/dummy-server-broken.ts | Same as F3 via alias file (also 3 non-JSON lines). | 1 |
| F5 | npx tsx src/cli.ts --timeout 2000 npx tsx src/failure-servers/garbage-stay-alive.ts | stderr multi-line Zod union: Error: Server produced invalid JSON-RPC output while waiting for connect: [ invalid_union invalid_value expected "2.0" path ["jsonrpc"] â€” valid JSON but invalid JSON-RPC rejected; proves garbage detection path. | 1 |
| F6 | npx tsx src/cli.ts --timeout 2000 npx tsx src/failure-servers/garbage-text-stay-alive.ts | **New spec-violation server:** plain non-JSON stdout staying alive. stderr: `Error: Request timed out after 4000ms (connect (requested 2000ms + 2000ms buffer = 4000ms)) â€” Server wrote 4 non-JSON line(s) to stdout (spec violation), first: "THIS IS NOT JSON - plain text spec violation line 1"` + stderr tail with tick 4. Truncation 200 and first 3 kept, N counts all. | 1 |
| F7 | npx tsx src/cli.ts npx tsx src/failure-servers/extra-field-raw.ts | Success: Lifecycle: legacy (2025-11-25) forced + Found 2 tool(s): extra fields present in programmatic tools array but CLI only prints name:description â€” verify via test-extra-field.ts. | 0 |
| F8 | npx tsx src/cli.ts npx tsx src/failure-servers/paginated.ts | Normal pagination: Found 5 tool(s): - tool_a: Tool A ... - tool_e: Tool E cap never hit. | 0 |
| F9 | npx tsx src/cli.ts does-not-exist-12345 | stderr: Error: Failed to spawn MCP server "does-not-exist-12345": Connection closed + tail 'does-not-exist-12345' is not recognized... Windows cross-spawn puts ENOENT on stderr; CLI sniffs both + not found/cannot find. | 1 |

### 5.5 Manual verification helpers (not CLI contract)

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| H1 | npx tsx src/test-pagination.ts | Cap test: Correctly threw Pagination safety cap exceeded (3 pages) PASS + normal 5-tool PASS. | 0 |
| H2 | npx tsx src/test-extra-field.ts | Section1 McpServer _meta Lifecycle modern count2 + has _meta true. Section2 raw x_custom Lifecycle legacy with x_custom_top/x_hidden flags. | 0 |
| H3 | npx tsx src/test-raw-request.ts | Connected era legacy -> Standard listTools strips x_custom_top false -> Raw passthrough preserves true + _meta true. Justifies client.request not listTools. | 0 |
| H4 | npx tsx src/inspect-client.ts | Dev dump: Client prototype methods [close,connect,getProtocolEra,...request...], own props, request type function, Protocol prototype. No spawn. | 0 |

### 5.6 Orphan / housekeeping checks

| # | Exact PowerShell command | What each output line means | Exit |
|---|---|---|---|
| O1 | Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where-Object { $_.CommandLine -like '*mcp-trust-check*' } | Lists orphaned node.exe after run. No output = good. Rows = orphans (known limitation; Layer 3 Docker). | 0 |
| O2 | dir baselines | After Layer 0: Cannot find path baselines because it does not exist (expected). After Layer 1: one <hash|name>.json per server. | 0 or error |

## 6. Ten Questions Judges Are Likely to Ask â€” With 2-Sentence Answers

| # | Judge question | 2-sentence answer |
|---|---|---|
| 1 | Why SDK v2 (@modelcontextprotocol/client 2.4.0) and not old sdk v1? | Spec moved to split client/server packages with modern lifecycle `server/discover` 2026-07-28; the only v1 data we have is that v1.30.0 has no `server/discover` (from earlier fetch), so v2 was needed to support both eras without reimplementing negotiation. We did not verify the full v1 API list, so we do not claim v1 lacks specific types. |
| 2 | Why dual lifecycle (try modern first, then legacy)? | Real servers span two eras â€” newer speak server/discover 2026-07-28 with _meta, older only initialize 2025-11-25. To be universal gate we probe modern via SDK sibling, and on -32601/UnsupportedProtocolVersion retry legacy so neither era is dropped. |
| 3 | Why a separate approve step at all? | Hash is tamper-evidence not safety: if first version was poisoned, every later check reports unchanged. So approve must itself run validate+LLM+human before baseline is saved, while check diffs and re-reviews â€” otherwise day-one poisoned tools pass forever. |
| 4 | Why a baseline per server (baselines/<hash>.json or --name) not one baseline.json? | Single file overwrites: approving weather then github forgets weather, so rug pull undetected â€” bug called out in baseline.ts. We hash command+null+args (null avoids ["a b","c"] vs ["a","b c"]) or sanitized alias with --name, each spawn has own artifact in gitignored baselines/. |
| 5 | Why is the LLM verdict advisory rather than blocking? | LLMs hallucinate both ways â€” miss obfuscated injection and flag benign boilerplate â€” so hard block would let poison through and block legit servers. Model (muse-spark-open-1026 via Baseten, reasoning extracted and zod-validated) is one signal alongside validation and sandbox, human is final gate. |
| 6 | Why does client.ts use client.request(..., passthrough) instead of nicer listTools()? | listTools validates through Tool schema with $strip â€” unknown fields like x_custom_top are silently dropped, so rug pull in extra field hashes identical. We proved in test-raw-request.ts (standard strips, raw preserves) so we use loose z.record passthrough to keep full raw object. |
| 7 | Why is timeout +1000 for tools/list and +2000 for connect? | RequestOptions.timeout is per-request, but connect does extra probe (sibling for modern discovery) so we add 2000ms outer buffer to avoid killing healthy handshake; pagination adds 1000ms per page. These are tuned values, not spec-mandated. |
| 8 | Why does garbage.ts previously timeout while garbage-stay-alive.ts is parse error? Is it fixed? | Originally ReadBuffer did `if (SyntaxError) continue` â€” plain non-JSON was silently skipped and surfaced only as timeout, whereas valid JSON that fails JSON-RPC `{"not":"jsonrpc"}` triggered `onerror`. We now add a side-channel hook that counts non-JSON stdout lines (first 3 truncated 200) and reports `Server wrote N non-JSON line(s) to stdout (spec violation)` on timeout/close, while still keeping successful tools. |
| 9 | Why all the Windows taskkill /pid /t /f + CIM cleanup? Can't you just process.kill(pid)? | On Windows npx -> node npx-cli.js -> node tsx -> node server creates grandchild chain where SIGTERM only kills parent leaving orphaned node.exe. cleanup() first kills whole tree by taskkill /t/f then CIM CommandLine fallback plus Unix SIGTERM/SIGKILL; Layer 3 will fix via Docker. |
| 10 | Exit codes 0/1 are not from MCP spec â€” why not use MCP error codes? | MCP codes (-32700..-32603) describe JSON-RPC failures inside session, but CLI exit is for shells/CI to gate deployments â€” must distinguish safe (0) from invalid/confirmed/operational (1/non-zero). So we keep MCP codes in stderr for debugging while proposal 0=clean,1=confirmed/other=operational lets compose with && and CI if: failure(). |

---

Rule: Exit 0 today means Layer 0 fetch succeeded (transport + tools/list OK). It does NOT mean safe.

---

## 7. Known Limitations and Anything Unverified

### 7.1 Confirmed limitations (documented, not hidden)

| Limitation | Impact today | Plan / workaround |
|---|---|---|
| Windows orphan processes | Killing tree via npx/cmd can still leave orphaned node grandchildren despite taskkill /t /f + CIM fallback; judge may see entries in Get-CimInstance after run. | README says Do not spend more time â€” Layer 3 will isolate in Docker. Mitigation in client.ts:cleanup() but not guaranteed. |
| Plain non-JSON stdout now reported (was silently skipped) | SDK ReadBuffer if (SyntaxError) continue, so server spamming THIS IS NOT JSON-RPC never triggers parse error â€” only surfaces as Request timed out or Connection closed. | Valid-JSON-but-not-JSON-RPC `{"not":"jsonrpc"}` still surfaces as `Server produced invalid JSON-RPC output` — both paths now covered via `garbage-text-stay-alive.ts` (plain) and `garbage-stay-alive.ts` (invalid JSON-RPC). |
| Layer 0 exit 0 != safe | Judges must not demo approve/check today as security gate â€” stubs always exit 0 on fetch success and never write baselines/*.json. | Next layers implement 0=clean,1=confirmed/invalid; README warns Exit code 0 here means Layer 0 fetch succeeded. |
| No file writes yet | getBaselinePath computes baselines/<hash|alias>.json but nothing reads/writes it; dir baselines errors. | Layer 1 adds canonicalize + SHA-256 + read/write + diff. |
| Extra-field preservation depends on passthrough | McpServer helpers may still strip custom x_* if not _meta; preservation guaranteed only for client.request passthrough and verified via raw servers. | Already proven; if SDK changes, test-raw-request.ts regresses. |
| garbage.ts / dummy-server-broken.ts ambiguous | Those files can resolve to timeout or closure depending scheduling; test:nonjson documents both as EXIT:1 but message varies. | Provide garbage-stay-alive.ts as deterministic parse-error case. |

### 7.2 Open / unverified items (carried from README)

| Item | State | What was done to reduce risk |
|---|---|---|
| SDK lifecycle probing internals | Probe sibling-process details live only in SDK source + client.ts comments, not README. Fallback on -32601 implemented and verified via dummy-server-legacy-only.ts (rejects discover -> legacy). | Behaviour proved, internals opaque. |
| Pagination cap | Initially open â€” now confirmed: fetchToolDefinitions enforces maxPages=100 and throws Pagination safety cap exceeded (...pages). Verified with pagination-infinite.ts and test-pagination.ts (maxPages:3). | Considered verified. |
| Timeout granularity | RequestOptions.timeout is per-request; we add 2000 outer for connect and 1000 per page. Values tuned not spec-mandated. | Logged in README. |
| Spawn-failure message on Windows | cross-spawn reports is not recognized... on stderr not ENOENT in throw; we sniff both plus not found/cannot find. | Tested live â€” sniff works. |
| LLM endpoint / Layer 2-3 | Baseten URL https://inference.baseten.co/v1 + model meta-models/muse-spark-open-1026 spec-quoted from PROJECT_CONTEXT â€” no network call made to verify. | Unverified until Layer 2 test; key from env never logged. |
| Tool schema exact optional fields | validate.ts spec says check Tool schema in SDK types / spec 2026-07-28; do not assume. No code yet â€” shape TBD. | Deferred; Layer 1 must re-read types. |

### 7.3 What was not run / not attempted (honest)

- No BASETEN_API_KEY was set and no LLM call sent â€” Layer 2 design-only.
- No Docker run, no sandbox reproduction â€” Layer 3 stretch may be cut.
- No publish to npm, no CI pipeline, no signing â€” scope is local gate only.
- npm view version checks listed in README asserted from package.json + installed tree, not re-fetched.

---

## Quick Demo Script for Judges (3 minutes, Windows PowerShell)

```
# 0) setup
npm install
npx tsc --noEmit                              # expect nothing -> pass

# 1) happy path â€” modern
npx tsx src/cli.ts npx tsx src/dummy-server.ts
# -> Lifecycle: modern (2026-07-28) + Found 2 tool(s)

# 2) fallback proof â€” legacy
npx tsx src/cli.ts npx tsx src/dummy-server-legacy-only.ts
# -> Lifecycle: legacy (2025-11-25)

# 3) per-server baseline path (no file yet)
npx tsx src/cli.ts approve npx tsx src/dummy-server.ts
npx tsx src/cli.ts check --name weather npx tsx src/dummy-server.ts
# -> baseline: baselines\853524f0e79ea788.json (auto hash) / baselines\weather.json (alias)

# 4) failure modes
npx tsx src/cli.ts --timeout 2000 npx tsx src/failure-servers/garbage-stay-alive.ts  # parse error
npx tsx src/cli.ts npx tsx src/failure-servers/exit-immediate.ts                      # crash
npx tsx src/cli.ts --timeout 1500 npx tsx src/failure-servers/timeout.ts              # timeout
npx tsx src/cli.ts does-not-exist-12345                                                # spawn fail
npx tsx src/test-pagination.ts                                                         # cap throw + 5-tool pass
npx tsx src/test-extra-field.ts                                                        # _meta + x_custom_top preserved

# 5) orphan check (optional)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mcp-trust-check*' }
# -> no output = cleanup worked (or note orphans = known Windows limitation)
```

---

## Where to Look Next

- Spec: PROJECT_CONTEXT.md (decisions) -> README.md (how to run) -> src/client.ts (real logic) -> src/cli.ts (arg parsing, baselines) -> src/baseline.ts (hash scheme).
- Proof servers: src/dummy-server-legacy-only.ts (legacy proof), src/failure-servers/garbage-stay-alive.ts (parse error), src/failure-servers/pagination-infinite.ts + src/failure-servers/paginated.ts (cap), src/failure-servers/extra-field-raw.ts (extra fields).
- Verification helpers: src/test-pagination.ts, src/test-extra-field.ts, src/test-raw-request.ts, src/inspect-client.ts.




