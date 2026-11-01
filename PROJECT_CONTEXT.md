# mcp-trust-check: project context and decisions

## Purpose
Node.js + TypeScript CLI for hackathon (Meta Global AI Developer Hackathon). Protects developers from malicious MCP servers:
- Tool poisoning: hidden instructions from start.
- Rug pull: server changes tool definition AFTER approval.
Target: developer who installs third-party MCP servers and wants gate before trusting (and later in CI).

## Hackathon constraints
- Repo must be fresh and public, containing only work done during event (Oct 27 - Nov 4, 2026).
- LLM: Muse Spark Open via Baseten, endpoint https://inference.baseten.co/v1, model meta-models/muse-spark-open-1026. JSON extracted from reasoning, zod-validated; retry on failure.
- API key only from env BASETEN_API_KEY. Never commit or log secrets.
- Scope fixed. Do not add features not asked for.

## Commands
- approve <server cmd> [--name N] [--accept] [--allow-invalid]: first-time acceptance. Fetch -> validate -> diff -> save.
- check <server cmd> [--name N]: every later run. Fetch -> validate -> diff vs baseline -> verdict. Read-only, never writes.

## Architecture (4 layers)
- Layer 0, MCP client: DONE. SDK v2 (client 2.4.0, server 2.4.0, zod 4). Dual lifecycle modern server/discover (2026-07-28) first, fallback legacy. fetchToolDefinitions returns {lifecycle, protocolVersion?, tools (FULL raw), protocolViolations, protocolViolationCount}. Passive listener on private _process.stdout counts non-JSON stdout.
- Layer 1, Validate + Diff: DONE (2026-10-31).
  - validate.ts: deterministic, no LLM. Shape: name non-empty string; description string if present; inputSchema object with type==="object" (SDK literal), properties/required optional; optional fields per installed ToolSchema (outputSchema, annotations, execution, _meta, icons, title). Cap 2000 (CONFIG). Content scan EVERY string recursively for zero-width, bidi, tag, HTML comment, markdown comment, base64 threshold 64. Duplicate names error. Non-standard top-level fields warning, ARE included in hash. Icons[].src exempt.
  - canonicalize.ts: sorted keys, array order kept, JSON.stringify, throw on non-JSON. Not full RFC 8785, acceptable. SHA-256 per tool + aggregate over sorted (name,toolHash).
  - baseline.ts: stores {schemaVersion:1, savedAt, command, args, lifecycle, protocolVersion, aggregateHash, previousKey?, tools:[{name,hash,definition}]}. Key unchanged: baselines/<16hex sha256(command+\0+args)>.json or baselines/<name>.json. read null if missing; clear error on corrupted/unknown. Atomic write temp+rename. Identity: compare stored command+args vs current -> "launch command changed" (does not block). Related: overlap = |common|/min(|current|,|baseline|) >=0.5 (CONFIG proposal), pick highest, report ties, skip unreadable. **Integrity verification (2026-11-01):** after schemaVersion check, `readBaseline` recomputes `hashTool(tool.definition)` vs stored `tool.hash` for each tool, then recomputes `aggregateHash` from stored `(name, hash)` pairs vs stored `aggregateHash`; on mismatch throws `Baseline integrity check failed for <file>: tool <name> definition does not match its stored hash (file modified after approval?)` or aggregate variant, without printing definition contents. `findRelatedBaselines` keeps skipping unreadable with warning (tampered now counts as unreadable, not crash). `approve`/`check` keep exit 2 on readBaseline errors (no change; report if different). This detects partial/accidental edits only; attacker with same file privilege can recompute hashes and bypass — real protection would need HMAC key outside file or baselines committed to git; listed as known limitation.
  - diff.ts: pure, by name: added, removed, changed (recursive field paths). Unchanged not listed.
  - CLI: approve/check as per README. TTY prompt via readline; non-TTY without --accept exits 1, never overwrites silently. Exit codes: 0 approved/unchanged, 1 differences/validation, 2 operational.
  - Decisions: x_hidden hashed (warning only); threshold 64 not 32; icons[].src exempt; overlap 0.5 proposal; identity limitation documented.
- Layer 2, LLM reviewer: planned, not implemented. Sends descriptions to Muse Spark Open, returns {suspicious, reason, category} advisory.
- Layer 3, Sandbox: stretch goal, may be cut. Docker + canary.


## Baseline storage
- One file per server: baselines/<16-hex sha256(command + \0 + args)>.json or baselines/<name>.json with --name (sanitized).
- baselines/ gitignored. Layer 1 reads/writes; Layer 0 only returns tools.

## Approve/check contract and exit codes
- approve: 0 approved/unchanged, 1 differences/validation not confirmed, 2 operational error.
- check: 0 unchanged+valid, 1 differences/validation (provisional until Layer 2), 2 operational (no baseline -> 2, advise run approve).
- Both print "LLM review and sandbox are not implemented yet." and keep protocolViolations.
- Identity limitation: identity = key from command+args or --name, plus tool-name overlap; server that changes launch command AND renames all tools is treated as new and goes through first-approval screening.

## Security rules
- MCP servers are untrusted code running with user privileges. Test only against own dummy servers or servers named explicitly.
- Never print env vars. Never execute anything server returns.

## How we work
- One layer at a time. Do NOT start Layer 2 until asked.
- Do not guess SDK APIs; read installed package types/docs. Report what could not be verified.
- Before each terminal command that deletes files or installs package, announce what it does.
- Keep README.md updated with how to run and what is known-unverified.

## Layer 1 status
- DONE as of 2026-10-31. All 4 corrections applied: whitelist from ToolSchema (9 fields), base64 threshold 64 with icons[].src exemption, inputSchema.type literal check, extend baseline.ts not new file.
- Tests: validate, canonicalize, diff, baseline, CLI.

## Known still open / unverified
- Overlap threshold 0.5 and base64 threshold 64 are proposals, not spec; may need tuning.
- TTY prompt on Windows without TTY: isTTY false -> requires --accept; verified manually but not in CI.
- SDK private _process.stdout hook may break on SDK update.
- Baseline integrity: as above — detects partial/accidental modification only, NOT attacker who recomputes hashes with same local-file privilege; real protection would need HMAC key outside file or committing baselines to git (and verifying history/signatures). Exit code behaviour unchanged (readBaseline errors → exit 2, findRelatedBaselines skips tampered with warning); report if different.
