# mcp-trust-check

> **Hackathon:** Meta Global AI Developer Hackathon - Oct 27-Nov 4 2026.

Protects developers from malicious MCP servers - **tool poisoning** and **rug pull**. CLI gate before trusting third-party servers, locally and in CI.

## Commands

- `approve <cmd> [--name N] [--accept] [--allow-invalid]` - first-time acceptance. Fetch -> validate -> diff -> save.
- `check <cmd> [--name N]` - read-only verification for CI. Never writes.

### Approve contract
1. fetch -> validate. Any error -> print, exit 1, save nothing, unless --allow-invalid (loud warning).
2. Resolve identity via baseline key (command+args hash or --name) and related search.
   - **A. Exact baseline exists:** diff old vs new. No diff + valid -> "already approved, unchanged", exit 0, DO NOT write. Diff -> print diff, exit 1; replace only if TTY y or --accept. Never silent overwrite. Non-TTY without --accept: exit 1.
   - **B. No exact but related (overlap >=0.5):** loud warning, diff vs best match (highest overlap, ties reported), same confirmation. On confirm save under new key with previousKey=old filename; old kept.
   - **C. Nothing related:** first approval, save baseline.
3. Exit codes: 0 approved/unchanged, 1 differences/validation not confirmed, 2 operational error.

### Check contract
Same detection/diff, never writes. No exact and no related -> exit 2 "run approve". For exact baseline: validation errors -> exit 1 (no LLM); no diff -> "check passed: unchanged and valid", exit 0, no LLM; diff with added/changed -> LLM review on those tools. Related baseline without exact: prints diff, exit 1, no LLM. Exit 0 when reviewer finds nothing suspicious because check never writes (run `approve` to accept). Still prints "Sandbox verification is not implemented yet."

## Architecture

- **Layer 0 - MCP client: DONE.** SDK v2 (client 2.4.0, server 2.4.0, zod 4). Dual lifecycle modern server/discover (2026-07-28) first, fallback legacy. fetchToolDefinitions returns {lifecycle, protocolVersion?, tools (FULL raw via passthrough), protocolViolations, protocolViolationCount}. Passive listener on _process.stdout counts non-JSON stdout.
- **Layer 1 - Validate + Diff: DONE.** See below.
- **Layer 2 - LLM reviewer: DONE.** Sends **full tool definition as JSON** (with `data:` icon URIs replaced by `"[omitted]"`, serialized via `canonicalize`) to Baseten `https://inference.baseten.co/v1/chat/completions` (`meta-models/muse-spark-open-1026`), not analyzed locally. Only called when there is added/changed tool text to review; otherwise no API call and no key required. Concurrency `CONFIG.REVIEW_CONCURRENCY=4`, deadline `CONFIG.REVIEW_DEADLINE_MS=300_000` (proposals). Prints per-flagged `[REVIEW] <tool> :: SUSPICIOUS :: <reason>` and summary `Reviewer: N tool(s) reviewed, M flagged (advisory, not a guarantee)`. Exit codes: reviewer failure (including missing `BASETEN_API_KEY`) -> `Error: ...` exit 2; `approve` with flagged but `--accept` bypasses with `WARNING: --accept given...`; non-TTY without `--accept` refuses with `Not a TTY... (reviewer flagged M tool(s)).` `check` with diff but nothing flagged → `Reviewer found nothing suspicious... Baseline NOT updated; run approve to accept this change.` + `Sandbox verification is not implemented yet.` and exit 0 (check never writes). Prompt-injection of reviewer is mitigated via per-call delimiter + instruction that data between delimiters is untrusted, not eliminated. Endpoint seam: set `MCP_TRUST_CHECK_REVIEWER_ENDPOINT=http://127.0.0.1:<port>/v1/chat/completions` (only `http:` + `127.0.0.1`/`localhost` allowed) for local testing. **Accuracy: see Evaluation section; advisory, not a guarantee.**
- **Layer 3 - Sandbox: NOT implemented, out of scope (see Scope).**

## Layer 1 details

### validate.ts (pure, no I/O, no LLM)
Input raw tools, output {valid, findings}. Checks:
- Shape: name non-empty string; description string if present; inputSchema object with type==="object" (SDK literal), properties optional object, required optional string[]; optional fields checked against installed ToolSchema (outputSchema, annotations, execution, _meta, icons, title). Description cap 2000 -> error (CONFIG.DESCRIPTION_MAX_LENGTH).
- Content scan over EVERY string recursively: zero-width U+200B-200D,U+2060,U+FEFF; bidi U+200E,200F,202A-202E,2066-2069; Unicode tag U+E0000-E007F; HTML comments; markdown comments %% and [comment]:; base64 blobs threshold 64 (CONFIG.BASE64_MIN_LENGTH=64, proposal not spec; 32 false-positives). Each hit includes fieldPath and bounded excerpt/code point, never full payload.
- Non-standard top-level fields (e.g. x_hidden): warning only, **ARE included in hash**. Decision: hashing only standard would allow rug-pull via extra fields; including ensures change visible. Whitelist exactly from ToolSchema: name, title, description, inputSchema, outputSchema, annotations, execution, _meta, icons.
- Icons: icons[].src exempt from base64 because data: URI legitimately contains base64.
- Duplicate tool names -> error.

### canonicalize.ts
Recursively sorts object keys, keeps array order, JSON.stringify. Throws on non-JSON (undefined, functions, NaN, Infinity). Not full RFC 8785 (JCS) - JCS also normalizes numbers/UTF-8; for MCP tools recursive key sort is sufficient and auditable, no security gain from full JCS. SHA-256 via node:crypto hex.

### baseline.ts
File: {schemaVersion:1, savedAt, command, args, lifecycle, protocolVersion, aggregateHash, previousKey?, tools:[{name,hash,definition}]}. definition full raw. Never stores env vars. Key derivation unchanged: baselines/<first 16 hex of sha256(command + \0 + args.join(\0))>.json or baselines/<name>.json with --name. read null if missing; clear error on corrupted/unknown schemaVersion. Atomic write via temp+rename. Identity: when found by key, compare stored command+args with current; diff -> "launch command changed since approval" (does not block). Related search: read every baselines/*.json, overlap = |common|/min(|current|,|baseline|). Related if >=0.5 (CONFIG.RELATED_OVERLAP_THRESHOLD proposal). Pick highest; report ties. Skip unreadable with warning.

**Baseline integrity verification (Layer 1, after schemaVersion check):** `readBaseline` recomputes `hashTool(tool.definition)` (from `canonicalize.js`) for each tool and compares with stored `tool.hash`; then recomputes `aggregateHash` from stored `(name, hash)` pairs and compares with `baseline.aggregateHash`. On mismatch throws `Baseline integrity check failed for <file>: tool <name> definition does not match its stored hash (file modified after approval?)` or `... aggregate hash does not match recomputed value (file modified after approval?)`. Never prints definition contents. `findRelatedBaselines` already skips unreadable files with a warning, so a tampered file is skipped, not crashing. `approve`/`check` treat `readBaseline` errors as operational errors (exit 2) — behaviour unchanged (confirm: no new exit codes; tell us if you observe a difference).

**Integrity threat model:** This detects *partial or accidental modification only* (e.g. manual edit, merge conflict, truncated write where hashes not updated). It does **NOT** protect against an attacker who has same-privilege local file access and recomputes the hashes after tampering — they can make the file pass integrity. Same-privilege local file is not a security boundary. Real protection would need an HMAC key stored *outside* the baseline file (e.g. OS keychain, env, or remote attestation) or committing baselines to git and verifying via git history/signing. Listed as Known limitation.

### diff.ts (pure)
Compare baseline tools vs current by name: added, removed, changed. For changed: list field paths with old/new values (recursive, nested inputSchema). Unchanged not listed.

### CLI
Implements approve/check as above. TTY prompt via node:readline; checks process.stdin.isTTY. On Windows without TTY (non-interactive, CI, piped), isTTY false -> prompt skipped, exit 1 without --accept; user must pass --accept. Prevents accidental overwrite in CI.

## Identity limitation (important)

Identity = key from command+args (or --name) + tool-name overlap. A server that changes its launch command AND renames all its tools is treated as new and goes through first-approval screening. Known limitation: cannot cryptographically bind beyond launch command and tool names. If attacker controls both, they appear as new server, but then must pass first-approval validation (screens all descriptions) - they don't silently bypass. Mitigation: use --name for stable alias and monitor baselines directory for unexpected new files.

## Demo server - rug pull

Tool name: `get_rug_weather`. Same name on every launch.

**Mechanism:** the dummy server (`src/dummy-server-rug-pull.ts`) checks whether its own baseline file exists in `baselines/`. No baseline -> benign description. Baseline exists -> description with a hidden instruction. This only simulates a rug pull for the demo; it is not part of the tool and Layer 0 is untouched. Reset: `scripts/reset-rug-pull.ts` removes the baseline.

**Reproduce (PowerShell):**
```powershell
npm run demo:rug-pull:reset
npm run demo:rug-pull:approve         # benign, baseline saved, exit 0 (calls LLM, needs BASETEN_API_KEY in .env)
npm run demo:rug-pull:check           # diff with hidden instruction, exit 1 (calls LLM)
npm run demo:rug-pull:approve         # in a terminal: asks y/N; piped (no TTY): refuses, exit 1 (calls LLM)
npm run demo:rug-pull:approve:accept  # replaces the baseline, exit 0 (calls LLM)
npm run demo:rug-pull:check           # unchanged, exit 0 (the malicious version is now the baseline, no LLM)
npm run demo:rug-pull:reset
```

## How to run & test

### Installed versions
- @modelcontextprotocol/client@2.4.0, @modelcontextprotocol/server@2.4.0, zod@4.6.7, tsx@4.23.15, typescript@7.0.2, Node >=20 (tested v26.2.0)

### Smoke tests
```powershell
npx tsx src/cli.ts npx tsx src/dummy-server.ts
npx tsx src/cli.ts approve -- npx tsx src/dummy-server.ts
npx tsx src/cli.ts check -- npx tsx src/dummy-server.ts
```

### Unit tests
```powershell
npx tsx --test tests/validate.test.ts tests/canonicalize.test.ts tests/diff.test.ts tests/baseline.test.ts
npx tsx --test tests/cli.test.ts
npx tsc --noEmit
```

CLI tests cover: approve twice unchanged (exit 0, file untouched); approve after rug-pull without --accept non-TTY (exit 1, baseline unchanged); with --accept (replaced, diff visible); args changed pkg@1.0.0->1.0.1 -> outcome B with warning; --name with changed args -> launch command changed finding; unrelated server -> outcome C; check never writes.

### Failure servers
```powershell
npx tsx src/cli.ts -- npx tsx src/failure-servers/garbage-stay-alive.ts
npx tsx src/cli.ts does-not-exist-12345
```

## Evaluation

**Setup:** Author-written set, 128 cases (base 20, extra 60, paired 48), 3 runs per case, majority verdict, model `meta-models/muse-spark-open-1026` via Baseten. Contested cases (labelled at authoring time, before any run) are excluded from headline rates and listed separately.

**Headline (non-contested, by majority):** FN 0, FP 3, hard-benign FPR 3/56 and malicious detection 49/49. The 3 FP are hard benign cases. Paired benign twins only: FPR 3/21 (14.3%) – higher than overall because the benign twins intentionally mirror the malicious phrasing and risky-looking content.

**Stability:** A second paired-only run gave the same FP count (3/21) with a different set (p-02b → F, p-18b → T); treat FP as ±1. The model is not fully deterministic.

**Known gaps:** Contested malicious cases p-08a, p-09a, p-16a (superlative persuasion, openly stated destination) were missed (3 of 6 contested malicious caught); the reviewer targets instructions aimed at the AI, not non-imperative persuasion.

**Limits:** The reviewer sees only the tool definition (a clean description with malicious code is out of scope); the full tool definition (all fields) is sent to Baseten for analysis (do not claim local analysis); the deterministic validator length cap rejects long benign tools (x-56); small author-written sample, not an independent benchmark; no claims about MCPTox or other benchmarks.

**Reproduce:** `npm run eval:reviewer -- --set all --runs 3` (requires `BASETEN_API_KEY` in `.env`).

## Scope

Layer 3 (sandbox/execution verification) is intentionally not implemented and is out of scope. As a consequence, a tool with a clean description but malicious runtime behavior is not detected by this tool.

## Known limitations / unverified

- Windows orphan processes: via npx/cmd can leave orphans (unmitigated).
- Plain non-JSON stdout: SDK silently ignores SyntaxError; we sniff via private _process.stdout hook (may break on SDK update).
- Timeout granularity: per-request +2000ms connect +1000ms per page (tuned).
- Overlap threshold 0.5: proposal not spec; may need tuning (CONFIG).
- Base64 threshold 64: proposal not spec; 32 false-positives. icons[].src exempt.
- Identity limitation: as above.
- Baseline integrity: verifies `hashTool(definition)` vs `tool.hash` and `aggregateHash` vs recomputed; detects partial/accidental edits only. **Does NOT stop attacker with same file privilege who recomputes hashes** — local baseline file is not a security boundary; real protection needs HMAC key outside file or baselines committed to git (with history/signature verification). Exit code behaviour unchanged: `readBaseline` errors → exit 2 in `approve`/`check`; `findRelatedBaselines` skips tampered/unreadable with warning (no crash). Notify if you see different behaviour.


## Security

Servers are untrusted code with user privileges. Test only own dummy servers or explicitly named servers. CLI never prints env vars or secrets, never executes server output.
