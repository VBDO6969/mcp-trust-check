#!/usr/bin/env node
import { fetchToolDefinitions } from "./client.js";

function printUsageAndExit(): never {
  console.error(`Usage: npx tsx src/cli.ts [--timeout <ms>] [--name <id>] [approve|check] <command> [args...]`);
  console.error(`npx tsx src/cli.ts approve npx tsx src/dummy-server.ts   # first-time gate (Layer 0 only for now)`);
  console.error(`       npx tsx src/cli.ts approve npx tsx src/dummy-server.ts   # auto baseline: baselines/<hash>.json`);
  console.error(`       npx tsx src/cli.ts check npx tsx src/dummy-server.ts     # later runs (same baseline)`);
  console.error(``);
  console.error(`Timeout precedence: --timeout flag > MCP_TRUST_CHECK_TIMEOUT env var > default 10000ms`);
  process.exit(1);
}

function parseArgs(argv: string[]): { command: string; args: string[]; timeoutMs: number; subcommand?: "approve" | "check"; baselineName?: string } {
  // argv is process.argv.slice(2)
  let timeoutMs: number | undefined = undefined;
  let remaining: string[] = [...argv];

  // Handle --timeout and --name flags placed before command
  // Support: --timeout 5000, --timeout=5000, --name my-server, --name=my-server
  let baselineName: string | undefined = undefined;
  let filtered: string[] = [];
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i];
    if (arg === "--timeout") {
      const val = remaining[i + 1];
      if (!val || val.startsWith("-")) {
        console.error("Error: --timeout requires a numeric value in ms");
        printUsageAndExit();
      }
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Error: invalid --timeout value "${val}" - must be positive integer`);
        process.exit(1);
      }
      timeoutMs = parsed;
      i++; // skip value
    } else if (arg.startsWith("--timeout=")) {
      const val = arg.slice("--timeout=".length);
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Error: invalid --timeout value "${val}"`);
        process.exit(1);
      }
      timeoutMs = parsed;
    } else if (arg === "--name" || arg === "--as" || arg === "--id") {
      const val = remaining[i + 1];
      if (!val || val.startsWith("-")) {
        console.error(`Error: ${arg} requires a value (e.g. --name weather)`);
        printUsageAndExit();
      }
      baselineName = val;
      i++;
    } else if (arg.startsWith("--name=")) {
      baselineName = arg.slice("--name=".length);
      if (!baselineName) { console.error("Error: --name requires a value"); printUsageAndExit(); }
    } else if (arg.startsWith("--as=")) {
      baselineName = arg.slice("--as=".length);
      if (!baselineName) { console.error("Error: --as requires a value"); printUsageAndExit(); }
    } else if (arg === "--") {
      // separator: everything after is command, even if it looks like flag
      // Push remaining as-is after --
      filtered.push(...remaining.slice(i + 1));
      break;
    } else {
      filtered.push(arg);
    }
  }

  // Support approve/check subcommands (Layer 0 only for now — just a gate stub)
  let subcommand: "approve" | "check" | undefined = undefined;
  if (filtered[0] === "approve" || filtered[0] === "check") {
    subcommand = filtered[0] as "approve" | "check";
    filtered = filtered.slice(1);
  }

  if (filtered.length === 0) {
    console.error("Error: no command provided to spawn MCP server");
    printUsageAndExit();
  }

  // Resolve timeout env var if not set via flag
  if (timeoutMs === undefined) {
    const envVal = process.env.MCP_TRUST_CHECK_TIMEOUT ?? process.env.MCP_TIMEOUT;
    if (envVal) {
      const parsed = Number(envVal);
      if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
      else {
        console.error(`Warning: ignoring invalid env timeout "${envVal}" - using default`);
      }
    }
  }
  if (timeoutMs === undefined) timeoutMs = 10000;

  const command = filtered[0];
  const args = filtered.slice(1);
  return { command, args, timeoutMs, subcommand, baselineName };
}

async function main() {
  const { command, args, timeoutMs, subcommand, baselineName } = parseArgs(process.argv.slice(2));
  // Per-server baseline: fixes the “weather vs github overwrites” bug
  // Without --name we hash the spawn command; with --name we use a human alias: baselines/<name>.json
  let baselinePath: string | undefined = undefined;
  if (subcommand === "approve" || subcommand === "check") {
    try {
      const { getBaselinePath } = await import("./baseline.js");
      baselinePath = getBaselinePath(command, args, { name: baselineName });
      console.error(`[mcp-trust-check] subcommand: ${subcommand} (Layer 0 only — Layer 1 not implemented yet)`);
      console.error(`[mcp-trust-check] baseline: ${baselinePath} ${baselineName ? `(alias: ${baselineName})` : `(auto hash of command)`}`);
    } catch {}
  } else if (subcommand) {
    console.error(`[mcp-trust-check] subcommand: ${subcommand} (Layer 0 only — Layer 1 not implemented yet)`);
  }

  // Safety: ensure no secrets logged
  // Never print env vars

  // Setup global handlers to avoid unhandled rejections crashing with stack trace
  let handlingError = false;

  const gracefulExit = async (code: number) => {
    if (handlingError) return;
    handlingError = true;
    process.exit(code);
  };

  process.on("SIGINT", async () => {
    console.error("\nReceived SIGINT - cleaning up and exiting...");
    await gracefulExit(130);
  });
  process.on("SIGTERM", async () => {
    console.error("\nReceived SIGTERM - cleaning up...");
    await gracefulExit(143);
  });
  process.on("unhandledRejection", (reason) => {
    // Convert to clean error message, non-zero exit, no stack trace unless needed
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`Unhandled error: ${msg}`);
    if (reason instanceof Error && reason.stack) {
      // Only show stack in verbose mode? For now hide to avoid crash appearance
      // console.error(reason.stack);
    }
    process.exit(1);
  });

  try {
    const result = await fetchToolDefinitions(command, args, { timeoutMs });

    // Log lifecycle to stderr (as required)
    const versionInfo = result.protocolVersion ? ` (protocol version: ${result.protocolVersion})` : "";
    console.error(`Lifecycle: ${result.lifecycle}${versionInfo}`);
    console.error(`Connected via ${result.lifecycle} flow - negotiated version: ${result.protocolVersion ?? "unknown"}`);
    // Surface protocol violations (MCP spec 2026-07-28: stdout MUST be only MCP messages) as trust signal
    const pv = (result as any).protocolViolations as string[] | undefined;
    const pvc = (result as any).protocolViolationCount as number | undefined;
    if (pv && pv.length > 0) {
      const n = pvc ?? pv.length;
      const first = pv[0] ?? "";
      console.error(`Warning: Server wrote ${n} non-JSON line(s) to stdout (spec violation), first: "${first}"`);
      for (let i = 1; i < pv.length; i++) console.error(`  violation ${i+1}: "${pv[i]}"`);
    }

    // Print tools to stdout human readable
    if (result.tools.length === 0) {
      console.log("No tools found.");
    } else {
      console.log(`Found ${result.tools.length} tool(s):`);
      for (const tool of result.tools) {
        const name = (tool as any).name ?? "<unknown>";
        const desc = (tool as any).description ?? "(no description)";
        console.log(`- ${name}: ${desc}`);
        // Optionally show more for debugging? Keep minimal per requirement
      }
    }

    if (subcommand === "approve" || subcommand === "check") {
      if (baselinePath) console.error(`[mcp-trust-check] baseline path for this server: ${baselinePath}`);
      console.error(`\n[not implemented yet: Layer 1] ${subcommand} would now run validate → ${subcommand === "approve" ? "LLM review → save baseline" : "diff → LLM review → sandbox"} (see PROJECT_CONTEXT.md)`);
      console.error(`Exit code 0 here means Layer 0 (fetch) succeeded; future Layer 1 will use 0=clean, 1=confirmed/invalid`);
    }
    // For Layer1 consumption: we return full objects via fetchToolDefinitions, but CLI only prints name+desc
    // Ensure clean exit with 0
    process.exit(0);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`Error: ${message}`);
    // Ensure non-zero exit, no thrown stack trace
    process.exit(1);
  }
}

main();
