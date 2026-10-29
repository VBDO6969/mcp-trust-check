# mcp-trust-check

> **Hackathon:** Meta Global AI Developer Hackathon — Oct 27–Nov 4 2026. Fresh public repo, only work done during the event.

Protects developers from malicious MCP servers — **tool poisoning** (a tool description contains hidden instructions from day one) and **rug pull** (a server changes a definition *after* the user approved it). The CLI is a gate *before* trusting a third-party server, for local use and later in CI.

## Commands (decided)

- `approve <server cmd>` — first-time acceptance. Fetch → validate → LLM review → human confirmation if flagged → save baseline. A hash baseline alone only proves "this is what was approved", not "this is safe", so the first approval must itself be screened — otherwise poisoned-from-day-one tools would pass.
- `check <server cmd>` — every later run. Fetch → validate → diff vs baseline → LLM review of changes → sandbox reproduction → verdict.

Both commands currently run Layer 0 only and print a "not implemented yet: Layer 1" notice. The gate logic will be added in the next layers.

## Architecture — 4 layers

- **Layer 0 — MCP client: DONE.** Spawns the server over stdio using SDK v2 (`@modelcontextprotocol/client 2.4.0`, `@modelcontextprotocol/server 2.4.0`, `zod 4`). Dual lifecycle: modern (`server/discover`, spec 2026-07-28) first, fallback to legacy (`initialize` + `notifications/initialized`). Exposes `fetchToolDefinitions(command, args, options)` returning `{lifecycle, protocolVersion?, tools}` where each tool is the **FULL raw object** (extra fields preserved via passthrough parsing, including `_meta` and custom `x_*`) because Layer 1 hashes every field.

- **Layer 1 — Validate + Diff: planned.** `validate.ts` is deterministic, no LLM. Shape: `name` is non-empty string; `description` is string if present; `inputSchema` is object (check Tool schema in installed SDK types / spec 2026-07-28 for exact optional fields; do not assume). Length cap ~2000 chars tunable. Content: scan *every* string field, including `description` nested inside `inputSchema.properties`, for zero-width/bidi control/Unicode tag characters, HTML or markdown comments, and long base64-like blobs. Invalid → `approve` is rejected unless explicitly overridden. Then canonicalize (recursively sorted keys) + SHA-256 via `node:crypto` + per-server `baselines/<hash>.json` (or `baselines/<name>.json` with `--name`) + diff (added/removed/changed with old vs new text).

- **Layer 2 — LLM reviewer: planned.** Sends changed (or, in `approve`, all) descriptions to **Muse Spark Open** via Baseten, OpenAI-compatible endpoint `https://inference.baseten.co/v1`, model ID exactly `meta-models/muse-spark-open-1026`. The model always reasons, so final JSON is extracted from output and validated with `zod`; retry on failure. Returns `{suspicious, reason, category}`. Advisory signal for a human decision, not a guarantee — models can be wrong both ways. API key only from env `BASETEN_API_KEY`, never logged or committed (see `.env.example`).

- **Layer 3 — Sandbox verifier: stretch goal, may be cut.** Run server in Docker with no real secrets and a fake canary file; generate test inputs from `inputSchema`; observe network/file behavior; verdicts `CONFIRMED / NOT REPRODUCED / INCONCLUSIVE`. If time runs short, `check` stops at Layer 2.

**Exit codes (proposal, not from MCP spec):** `0` clean/benign, `1` confirmed or invalid, other non-zero operational error.

## Layer 0 — how to run & test

### Installed SDK versions

Verified via `npm view` and installed packages:

- `@modelcontextprotocol/client@2.4.0`
- `@modelcontextprotocol/server@2.4.0`
- `zod@4.6.7` · `tsx@4.23.15` · `typescript@7.0.2` · Node `>=20` (tested on v26.2.0)

### SDK APIs used

Checked installed types/README before coding (no v1 `@modelcontextprotocol/sdk`):

**Client (`@modelcontextprotocol/client`):**
- `Client` from `"@modelcontextprotocol/client"` + `StdioClientTransport` from `"@modelcontextprotocol/client/stdio"` (`command`, `args`, `stderr:"pipe"`)
- `ClientOptions.versionNegotiation`: `{mode:"auto", probe:{timeoutMs, maxRetries:0}}` for modern, `{mode:"legacy"}` for fallback
- `client.connect(transport,{timeout})` — handshake (modern probe via disposable sibling process or legacy initialize)
- `client.getProtocolEra()` → `"modern"|"legacy"` + `getNegotiatedProtocolVersion()` + `client.request({method:"tools/list"}, LooseSchema)` with passthrough (preserves unknown fields; `listTools` would strip them via `$strip`)
- `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (we default to `10000` per request, configurable)

**Server (`@modelcontextprotocol/server`):**
- `McpServer` + `serveStdio(factory, {legacy?})` — owns era decision; `StdioServerTransport` alternative
- `server.registerTool(name, {description, inputSchema: z.object(...), _meta?}, handler)` → `{content:[{type:"text"}]}`

**Lifecycle:** Modern (`2026-07-28`): `server/discover` first, then every request carries `_meta` (`protocolVersion`, `clientInfo`, `clientCapabilities`). Legacy (`2025-11-25`): `initialize` + `notifications/initialized`. We try modern first; on `MethodNotFound -32601` / `UnsupportedProtocolVersion` we retry legacy. Logged to `stderr`.

**What was checked in docs:** `client/dist/index.d.mts` (`VersionNegotiationOptions`, `getProtocolEra`, `getNegotiatedProtocolVersion`), `client/dist/stdio.d.mts` (`StdioServerParameters`), `server/dist/stdio.d.mts` (`serveStdio` legacy option), `core` protocol files (`RequestOptions: {timeout?, signal?}`).

### Project structure

```
src/
  cli.ts                     # approve/check subcommands + --timeout, env, exit codes
  client.ts                  # fetchToolDefinitions(command,args,options) → {lifecycle, protocolVersion, tools}
  dummy-server.ts            # 2 tools: get_weather, add_numbers via serveStdio
  dummy-server-legacy-only.ts# hand-written legacy-only server (rejects discover) — proves fallback
  dummy-server-extra-field.ts# _meta preservation test
  failure-servers/
    exit-immediate.ts        # crash on start
    garbage.ts               # plain non-JSON then exit
    garbage-stay-alive.ts    # valid JSON but not JSON-RPC → triggers SDK validation error
    timeout.ts               # never responds (hang)
    pagination-infinite.ts   # infinite nextCursor (cap test)
    extra-field-raw.ts       # raw tools with x_custom_top
    paginated.ts             # 5 tools
  test-*.ts, inspect-client.ts # manual checks (not part of CLI)
```

### Usage (Layer 0)

```bash
npm install

# Direct fetch (backward compatible)
npx tsx src/cli.ts npx tsx src/dummy-server.ts
npx tsx src/cli.ts --timeout 5000 npx tsx src/dummy-server.ts
npx tsx src/cli.ts -- npx tsx src/dummy-server.ts
MCP_TRUST_CHECK_TIMEOUT=5000 npx tsx src/cli.ts npx tsx src/dummy-server.ts
# also supports MCP_TIMEOUT as alias

# Gate commands (Layer 0 only for now — Layer 1 will add validate/diff/LLM/sandbox)
npx tsx src/cli.ts approve npx tsx src/dummy-server.ts
npx tsx src/cli.ts check npx tsx src/dummy-server.ts
npx tsx src/cli.ts --timeout 5000 approve npx tsx src/dummy-server.ts

# Output contract for Layer 1
import { fetchToolDefinitions } from "./src/client.js";
const {lifecycle, protocolVersion, tools} = await fetchToolDefinitions("npx", ["tsx","src/dummy-server.ts"], {timeoutMs:10000});
// tools are FULL raw objects (name, description, inputSchema, _meta, x_custom...) — not reduced
```

CLI prints `name: description` for humans on `stdout`; `lifecycle` + version goes to `stderr`. Full objects are returned for hashing.

**Timeout precedence:** `--timeout` flag > `MCP_TRUST_CHECK_TIMEOUT` / `MCP_TIMEOUT` env > `10000ms` default.

### Tests / Definition of Done

All Layer 0 checks still pass:

```bash
npx tsc --noEmit

# 1. Modern dummy — 2 tools, modern log
npx tsx src/cli.ts npx tsx src/dummy-server.ts
# → Lifecycle: modern (2026-07-28) + Found 2 tool(s)

# 2. Legacy-only dummy — proves fallback
npx tsx src/cli.ts npx tsx src/dummy-server-legacy-only.ts
# → Lifecycle: legacy (2025-11-25)

# 3. Garbage (valid JSON but not JSON-RPC) — parse error, not Connection closed
npx tsx src/cli.ts --timeout 2000 npx tsx src/failure-servers/garbage-stay-alive.ts
# → Error: Server produced invalid JSON-RPC output...

# 4. Exit-immediate — crash
npx tsx src/cli.ts npx tsx src/failure-servers/exit-immediate.ts
# → Error: MCP server process exited... + stderr tail, EXIT:1

# 5. Timeout — hang
npx tsx src/cli.ts --timeout 1500 npx tsx src/failure-servers/timeout.ts
# → Error: Request timed out, EXIT:1

# 6. Spawn failure — command not found / permission
npx tsx src/cli.ts does-not-exist-12345
# → Error: Failed to spawn MCP server... + is not recognized / ENOENT, EXIT:1

# 7. Pagination cap — throws, never silently truncates
npx tsx src/test-pagination.ts
# → Pagination safety cap exceeded (3 pages)...

# 8. Extra-field preservation — x_custom_top kept
npx tsx src/test-extra-field.ts
# → has x_custom_top: true

# Orphans: after each run no dummy child process should remain
# Windows: Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | Where CommandLine -like "*mcp-trust-check*"
# Unix: ps aux | grep dummy

npm run test:cli        # dummy
npm run test:legacy     # legacy dummy
npm run approve -- npx tsx src/dummy-server.ts   # gate stub
npm run check -- npx tsx src/dummy-server.ts
```

## Known limitations (Layer 0)

- **Windows orphan processes:** Killing the process tree through `npx`/`cmd` can leave orphaned `node` grandchildren. Documented here; do not spend more time — Layer 3 will isolate servers in Docker anyway. Current `client.ts` does `taskkill /pid /t /f` + PowerShell `Stop-Process` by script pattern as fallback.

- **Plain non-JSON stdout:** Silently ignored by the SDK (`ReadBuffer.readMessage()` does `if (error instanceof SyntaxError) continue`). Surfaces only as a timeout. Valid-JSON-but-not-JSON-RPC (e.g. `{"not":"jsonrpc"}`) *does* surface as `Server produced invalid JSON-RPC output` and is used for the garbage test.

- **Open item — page cap:** Now confirmed: `fetchToolDefinitions` itself enforces `maxPages=100` and **throws** `Pagination safety cap exceeded` when exceeded, whether via `client.request` (current) or `listTools`. Verified with `pagination-infinite.ts` (see test output below).

## Security: servers are untrusted code

MCP servers run with the user''s privileges. **Test only against your own dummy servers or servers you name explicitly.** The CLI never prints environment variables, never executes anything a server returns, and treats all tool output as data for hashing/diffing only.

## How we work

- One layer at a time. Do **not** start Layer 1 until the Layer 1 task is sent.
- Do not guess SDK APIs; read installed package types/docs. Report what could not be verified.
- Before any terminal command that deletes files or installs a package, announce what it does.
- Keep this README updated with how to run and what is known-unverified.

## Unsure / could not fully verify (kept from Layer 0)

- **SDK lifecycle probing:** Exact probe sibling-process internals are only in code comments, not README. Fallback for `-32601` is implemented and now verified via hand-written legacy-only server.
- **Pagination:** Verified to throw on cap (see `test-pagination.ts`). Normal 5-tool server correctly returns all tools in one page.
- **Garbage detection:** Plain non-JSON is intentionally skipped by SDK; valid-JSON-but-not-JSON-RPC correctly surfaces as error. Full stdout sniffing would require custom transport.
- **Timeout granularity:** `RequestOptions.timeout` is per-request; we add 2000 ms outer buffer for connect (probe overhead) and 1000 ms per page.
- **Orphan handling on Windows:** As above — documented, not blocking.
- **Spawn failure on Windows:** `cross-spawn` reports `is not recognized as internal or external command` on stderr rather than `ENOENT`; we sniff both plus `not found`/`cannot find`.
