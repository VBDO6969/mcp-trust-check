# mcp-trust-check: project context and decisions

## Purpose
Node.js + TypeScript CLI for a hackathon (Meta Global AI Developer Hackathon). It protects developers from malicious MCP servers:
- Tool poisoning: a tool description contains hidden instructions for the AI from the start.
- Rug pull: a server changes a tool definition AFTER the user approved it.
Target user: a developer who installs third-party MCP servers and wants a gate before trusting them (and later, in CI).

## Hackathon constraints
- Repo must be fresh and public, containing only work done during the event (Oct 27 - Nov 4, 2026). No old code.
- LLM: Muse Spark Open via Baseten, OpenAI-compatible endpoint https://inference.baseten.co/v1, model id exactly `meta-models/muse-spark-open-1026`. The model always reasons, so the final JSON must be extracted from its output and validated with zod; retry on failure.
- API key only from an environment variable (BASETEN_API_KEY). Never commit or log secrets.
- Scope is fixed. Do not add features, commands, or layers I have not asked for.

## Commands (decided)
- `approve <server cmd>`: first-time acceptance. Fetch -> validate -> LLM review -> human confirmation if flagged -> save baseline.
- `check <server cmd>`: every later run. Fetch -> validate -> diff vs baseline -> LLM review of changes -> sandbox reproduction -> verdict.
Reason: a hash baseline only proves "this is what was approved", not "this is safe". So the first approval itself must be screened, otherwise poisoned-from-day-one tools pass.

## Architecture (4 layers)
- Layer 0, MCP client: DONE. Spawns the server over stdio using SDK v2 (@modelcontextprotocol/client 2.4.0, @modelcontextprotocol/server 2.4.0, zod 4). Dual lifecycle: modern (server/discover, spec 2026-07-28) first, fallback to legacy (initialize + notifications/initialized). Exposes `fetchToolDefinitions(command, args, options)` returning `{lifecycle, protocolVersion?, tools, protocolViolations, protocolViolationCount}` where each tool is the FULL raw object (extra fields preserved via passthrough parsing) because Layer 1 hashes every field. A passive listener on the transport's private `_process.stdout` counts non-JSON stdout lines (spec violation — MCP stdio spec requires stdout to be JSON-RPC only) and keeps the first 3, truncated to 200 chars, exposed via `protocolViolations` / `protocolViolationCount`.
- Layer 1, Validate + Diff:
  - validate.ts, deterministic, no LLM. Shape: name is a non-empty string; description is a string if present; inputSchema is an object (check the Tool schema in the installed SDK types / spec 2026-07-28 for exact optional fields; do not assume). Length cap (proposal: 2000 chars, tunable). Content: scan EVERY string field, including `description` nested inside inputSchema.properties, for zero-width/bidi control/Unicode tag characters, HTML or markdown comments, and long base64-like blobs. Invalid -> approve is rejected unless I explicitly override.
  - canonicalize (recursively sorted keys) + SHA-256 via node:crypto + baseline.json + diff (added / removed / changed tools, with old vs new text).
  - Non-standard tool fields (e.g. `x_hidden`) are kept raw by Layer 0 (passthrough parsing) and the decision whether they enter the hash (low severity) is still open.
- Layer 2, LLM reviewer: sends changed (or, in approve, all) descriptions to Muse Spark Open, returns structured JSON verdict `{suspicious, reason, category}`. It is an ADVISORY signal for a human decision, not a guarantee. Models can be wrong in both directions.
- Layer 3, Sandbox verifier (stretch goal, may be cut): run the server in Docker with no real secrets and a fake canary file, the model generates test inputs from inputSchema, observe network/file behavior, compare with the description. Verdicts: CONFIRMED / NOT REPRODUCED / INCONCLUSIVE. If time runs short, `check` stops at Layer 2.
- Exit codes (my proposal, not from the MCP spec): 0 = clean/benign, 1 = confirmed or invalid, other non-zero = operational error.

## Layer 0 status and known limitations
- Verified by tests: modern flow, legacy-only fallback (hand-written legacy server), pagination (infinite cursor is capped and THROWS, never silently truncates), extra-field preservation, timeouts, spawn failure, valid-JSON-but-not-JSON-RPC output. The cap of 100 is enforced in `fetchToolDefinitions` and throws (verified).
- Known limitation: on Windows, killing the process tree through npx/cmd can leave orphaned node processes. Document in README, do not spend more time on it. Layer 3 will isolate servers in Docker anyway.
- Plain non-JSON stdout lines are now reported as `Server wrote N non-JSON line(s) to stdout (spec violation)` via `protocolViolations`/`protocolViolationCount`; the detection relies on a private SDK field (`_process.stdout`), so it can break on SDK updates (and the CLI should warn if the hook is lost).

## Baseline storage
- One file per server: `baselines/<16-hex sha256(command + \0 + args)>.json` (first 16 hex chars of SHA-256 of `command + '\0' + args.join('\0')`), or `baselines/<name>.json` with `--name` (sanitized).
- `baselines/` is gitignored.
- Layer 1 will read and write it (Layer 0 never touches baselines; it only returns `tools` + `protocolViolations`).

## Security rules
- MCP servers are untrusted code running with the user's privileges. Test only against my own dummy servers or servers I name explicitly.
- Never print environment variables. Never execute anything a server returns.

## How we work
- One layer at a time. Do NOT start Layer 1 until I send the Layer 1 task.
- Do not guess SDK APIs; read the installed package types/docs. Report what you could not verify.
- Before each terminal command that deletes files or installs a package, tell me what it does.
- Keep README.md updated with how to run and what is known-unverified.