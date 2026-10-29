import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/client";

export type ToolDefinition = Tool & Record<string, unknown>;

export interface FetchToolDefinitionsResult {
  lifecycle: "modern" | "legacy";
  protocolVersion?: string;
  tools: ToolDefinition[];
  protocolViolations: string[];
  protocolViolationCount: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxPages?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 100;

export async function fetchToolDefinitions(
  command: string,
  args: string[],
  options: FetchOptions = {}
): Promise<FetchToolDefinitionsResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  if (!command) throw new Error("No command provided to spawn MCP server");

  const attempt = async (mode: "auto" | "legacy"): Promise<FetchToolDefinitionsResult> => {
    const transport = new StdioClientTransport({
      command,
      args,
      stderr: "pipe",
    });

    const stderrChunks: Buffer[] = [];
    let stderrText = "";
    const stderrStream = (transport as any).stderr as NodeJS.ReadableStream | null;
    if (stderrStream) {
      (stderrStream as any).on("data", (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        stderrChunks.push(buf);
        const combined = Buffer.concat(stderrChunks);
        if (combined.length > 64 * 1024) {
          const sliced = combined.subarray(combined.length - 64 * 1024);
          stderrChunks.length = 0;
          stderrChunks.push(sliced);
        }
        stderrText = Buffer.concat(stderrChunks).toString("utf-8");
      });
    }

    // --- MCP spec 2026-07-28 violation detection: plain non-JSON stdout ---
    // SDK analysis (read installed stdio.d.mts + stdio.mjs):
    //   StdioClientTransport exposes only stderr (get stderr) and pid; stdout is private _process.stdout.
    //   No public stdout hook. ReadBuffer.readMessage() silently continues on SyntaxError, hiding violations.
    //   Least-invasive: peek at private _process.stdout via (transport as any)._process?.stdout and add
    //   passive side-channel listener that counts non-JSON lines (first 3 truncated 200 chars). Does not
    //   intercept or mutate data flow; survives SDK updates (degrades to zero violations if private renamed).
    const protocolViolations: string[] = [];
    let protocolViolationCount = 0;
    let violationHookAttached = false;
    let stdoutBuffer = "";
    const handleStdoutChunk = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      stdoutBuffer += text;
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const rawLine = stdoutBuffer.slice(0, idx).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!rawLine.trim()) continue;
        try { JSON.parse(rawLine); } catch (e: any) {
          const isSyntax = e instanceof SyntaxError || e?.name === "SyntaxError";
          if (isSyntax) { protocolViolationCount++; if (protocolViolations.length < 3) protocolViolations.push(rawLine.slice(0, 200)); }
        }
      }
    };
    const flushStdoutViolations = () => {
      const pending = stdoutBuffer.trim();
      if (pending) {
        try { JSON.parse(pending); } catch (e: any) { if (e instanceof SyntaxError || e?.name === "SyntaxError") { protocolViolationCount++; if (protocolViolations.length < 3) protocolViolations.push(pending.slice(0, 200)); } }
        stdoutBuffer = "";
      }
    };
    const attachViolationListener = () => {
      const proc: any = (transport as any)._process;
      const stdout: any = proc?.stdout;
      if (stdout && typeof stdout.on === "function" && !(stdout as any).__mcpViolationHooked) {
        stdout.on("data", handleStdoutChunk);
        (stdout as any).__mcpViolationHooked = true;
        violationHookAttached = true;
      }
    };
    // Attach as early as possible via polling for _process (covers probe sibling timing)
    let violationPoll: NodeJS.Timeout | null = null;
    const startViolationPolling = () => {
      violationPoll = setInterval(() => {
        const proc: any = (transport as any)._process;
        const stdout: any = proc?.stdout;
        if (stdout && typeof stdout.on === "function" && !(stdout as any).__mcpViolationHooked) {
          stdout.on("data", handleStdoutChunk);
          (stdout as any).__mcpViolationHooked = true;
          violationHookAttached = true;
        }
        if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
          // process exited, stop polling
          if (violationPoll) clearInterval(violationPoll);
        }
      }, 5);
      // also try immediate attach in case _process already exists (e.g. fallback reuse)
      attachViolationListener();
    };
    startViolationPolling();
    const getViolationSuffix = (): string => {
      if (protocolViolationCount > 0) {
        flushStdoutViolations();
        const first = protocolViolations[0] ?? "";
        return "Server wrote " + protocolViolationCount + " non-JSON line(s) to stdout (spec violation), first: \"" + first + "\"";
      }
      return "";
    };
    const warnIfHookLost = (): string => {
      if (!violationHookAttached) {
        return " [warning: stdout hook not attached — SDK _process may have been renamed, violations not observable]";
      }
      return "";
    };

    let transportError: Error | null = null;
    // Capture transport errors even when Client overwrites the handler
    // Simple approach: set handler before connect, then re-wrap after connect
    const prevOnError = (transport as any).onerror;
    (transport as any).onerror = (err: Error) => {
      transportError = err;
      if (prevOnError) prevOnError(err);
    };

    const getStderrTail = (lines = 20): string => {
      if (!stderrText) return "";
      const all = stderrText.split("\n");
      return all.slice(-lines).join("\n").trim();
    };

    const buildErrorWithStderr = (msg: string, extra?: string): Error => {
      const tail = getStderrTail();
      const stderrPart = tail ? `\n--- server stderr (last ${20} lines) ---\n${tail}\n--- end stderr ---` : "";
      const extraPart = extra ? `\n${extra}` : "";
      return new Error(`${msg}${extraPart}${stderrPart}`);
    };

    let sigintHandler: (() => void) | null = null;
    const client = new Client(
      { name: "mcp-trust-check", version: "1.0.0" },
      {
        capabilities: {},
        listMaxPages: maxPages,
        versionNegotiation: mode === "auto" ? { mode: "auto", probe: { timeoutMs, maxRetries: 0 } } : { mode: "legacy" },
      }
    );

    // Helper to ensure we keep capturing errors after Client overwrites handler
    const wrapTransportErrorHandler = () => {
      const current = (transport as any).onerror;
      if (current && (current as any).__wrapped !== true) {
        const orig = current;
        const wrapped = (err: Error) => {
          transportError = err;
          orig(err);
        };
        (wrapped as any).__wrapped = true;
        (transport as any).onerror = wrapped;
      }
    };

    const cleanup = async () => {
      if (violationPoll) { clearInterval(violationPoll); violationPoll = null; }
      if (sigintHandler) process.off("SIGINT", sigintHandler);
      const pid = (transport as any).pid as number | null;
      // Windows: kill process tree BEFORE close, while parent still alive to avoid orphaned grandchild
      // On Windows, npx spawns via node npx-cli.js -> node tsx -> node server, and SIGTERM only kills parent, leaving grandchild orphaned
      // So we use taskkill /t to kill the whole tree, and also kill by CommandLine pattern as fallback
      if (process.platform === "win32" && pid) {
        try {
          const { execSync } = await import("node:child_process");
          // First, try to kill by PID tree
          try { execSync(`taskkill /pid ${pid} /t /f`, { stdio: "ignore" }); } catch {}
          // Fallback: kill any remaining node processes that match the server args (orphaned grandchildren)
          // Extract server command from transport args for targeted cleanup
          const serverCmd = (transport as any)._serverParams?.command || "";
          const serverArgs = ((transport as any)._serverParams?.args || []).join(" ");
          const targetPattern = serverArgs ? serverArgs.split(" ").pop() || "" : "";
          if (targetPattern && targetPattern.includes(".ts")) {
            try {
              // Kill any node with that script in CommandLine (covers orphaned tsx/node children)
              execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*${targetPattern}*' } | ForEach-Object { taskkill /pid $_.ProcessId /t /f  }" `, { stdio: "ignore" });
            } catch {}
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      try { await client.close(); } catch {}
      try { await (transport as any).close(); } catch {}
      if (pid) {
        // Fallback: try SIGTERM/SIGKILL if still alive (non-Windows or taskkill failed)
        try {
          process.kill(pid, 0);
          try { process.kill(pid, "SIGTERM"); } catch {}
          await new Promise((r) => setTimeout(r, 200));
          try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
        } catch {}
        if (process.platform === "win32") {
          try {
            const { execSync } = await import("node:child_process");
            execSync(`taskkill /pid ${pid} /t /f`, { stdio: "ignore" });
            // Again kill by pattern to catch orphans
            const serverArgs = ((transport as any)._serverParams?.args || []).join(" ");
            const targetPattern = serverArgs ? serverArgs.split(" ").pop() || "" : "";
            if (targetPattern && targetPattern.includes(".ts")) {
              try { execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*${targetPattern}*' } | ForEach-Object { taskkill /pid $_.ProcessId /t /f  }" `, { stdio: "ignore" }); } catch {}
            }
          } catch {}
        }
      }
    };

    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (transportError) {
            const v = getViolationSuffix() || warnIfHookLost();
            const base = `Server produced invalid JSON-RPC output while waiting for ${label}: ${(transportError as Error).message}`;
            const msg = v ? `${base} — ${v}` : base;
            reject(buildErrorWithStderr(msg));
          } else {
            const v = getViolationSuffix() || warnIfHookLost();
            const buffer = ms - timeoutMs;
            const labelDetail = buffer > 0 ? `${label} (requested ${timeoutMs}ms + ${buffer}ms buffer = ${ms}ms)` : `${label} (${ms}ms)`;
            const base = `Request timed out after ${ms}ms (${labelDetail}). Server did not respond in time. This may indicate the server sent non-JSON-RPC garbage to stdout that was silently skipped (SDK skips SyntaxError lines) or the server crashed without responding. Check stderr and ensure stdout carries ONLY JSON-RPC.`;
            const msg = v ? `${base} — ${v}` : base;
            reject(buildErrorWithStderr(msg));
          }
        }, ms);
        (timer as any).unref?.();
      });
      return Promise.race([p, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    sigintHandler = () => {};
    process.on("SIGINT", sigintHandler);

    try {
      const connectPromise = client.connect(transport as any, { timeout: timeoutMs } as any);
      // Re-wrap immediately after connect sets its handler (synchronously)
      wrapTransportErrorHandler();
      // Also re-wrap after a tick in case Client sets it async
      setTimeout(wrapTransportErrorHandler, 0);
      await withTimeout(connectPromise, timeoutMs + 2000, "connect");
      // Re-wrap again for tools/list phase
      wrapTransportErrorHandler();

      if (transportError) {
        throw buildErrorWithStderr(`Server produced invalid JSON-RPC message: ${(transportError as Error).message}`);
      }

      const protocolVersion = (client as any).getNegotiatedProtocolVersion?.() as string | undefined;
      const era = (client as any).getProtocolEra?.() as string | undefined;
      let lifecycle: "modern" | "legacy" = era === "modern" ? "modern" : "legacy";

      // Use raw request with passthrough to preserve unknown fields (e.g. x_custom) that standard ToolSchema strips via $strip
      // Standard listTools uses ToolSchema with z.core.$strip, so top-level custom fields would be lost and Layer 1 hashing would miss rug pull
      const LooseToolsListResult = z
        .object({
          tools: z.array(z.record(z.string(), z.unknown())),
          nextCursor: z.string().optional(),
          _meta: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough();
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined = undefined;
      let pages = 0;

      do {
        if (pages >= maxPages) {
          throw buildErrorWithStderr(`Pagination safety cap exceeded (${maxPages} pages) while listing tools. Possible infinite loop via nextCursor.`);
        }
        wrapTransportErrorHandler();
        let result: any;
        // Use client.request with loose schema to keep FULL raw object (requirement: keep every field for hashing)
        const params = cursor ? { cursor } : {};
        if (cursor) {
          result = await withTimeout(
            (client as any).request({ method: "tools/list", params }, LooseToolsListResult, { timeout: timeoutMs }),
            timeoutMs + 1000,
            `tools/list (page ${pages + 1})`
          );
        } else {
          result = await withTimeout(
            (client as any).request({ method: "tools/list", params }, LooseToolsListResult, { timeout: timeoutMs }),
            timeoutMs + 1000,
            `tools/list (page ${pages + 1})`
          );
        }

        if (transportError) {
          throw buildErrorWithStderr(`Server sent invalid JSON-RPC during tools/list: ${(transportError as Error).message}`);
        }
        if (!result || !Array.isArray(result.tools)) {
          throw buildErrorWithStderr(`Invalid response for tools/list: expected { tools: [] } but got ${JSON.stringify(result)}`);
        }
        for (const t of result.tools) tools.push(t as ToolDefinition);
        cursor = result.nextCursor;
        pages++;
        if (!cursor) break;
      } while (cursor);

      const finalEra = (client as any).getProtocolEra?.() as string | undefined;
      const finalLifecycle: "modern" | "legacy" = finalEra === "modern" ? "modern" : "legacy";
      const finalVersion = (client as any).getNegotiatedProtocolVersion?.() as string | undefined;
      flushStdoutViolations();
      await cleanup();
      return { lifecycle: finalLifecycle, protocolVersion: finalVersion ?? protocolVersion, tools, protocolViolations, protocolViolationCount };
    } catch (err: any) {
      await cleanup();
      const message = err?.message ?? String(err);
      if (message.includes("ENOENT") || message.includes("EACCES") || message.toLowerCase().includes("spawn") || message.toLowerCase().includes("is not recognized") || getStderrTail().toLowerCase().includes("is not recognized") || getStderrTail().toLowerCase().includes("not found") || getStderrTail().toLowerCase().includes("cannot find")) {
        throw buildErrorWithStderr(`Failed to spawn MCP server "${command}": ${message}`);
      }
      if (message.toLowerCase().includes("parse") || message.toLowerCase().includes("unexpected token") || transportError) {
        if (!message.includes("server stderr")) throw buildErrorWithStderr(`Server produced invalid JSON-RPC output: ${message}`);
      }
      if (!message.includes("server stderr") && message.toLowerCase().includes("timed out")) {
        const v = getViolationSuffix() || warnIfHookLost();
        const msg = v ? `${message} — ${v}` : message;
        throw buildErrorWithStderr(msg);
      }
      if (!message.includes("server stderr") && (message.toLowerCase().includes("closed") || message.toLowerCase().includes("exit"))) {
        const v = getViolationSuffix() || warnIfHookLost();
        const base = `MCP server process exited or closed connection: ${message}`;
        const msg = v ? `${base} — ${v}` : base;
        throw buildErrorWithStderr(msg);
      }
      if (!message.includes("server stderr")) throw buildErrorWithStderr(message);
      throw err;
    }
  };

  try {
    return await attempt("auto");
  } catch (err: any) {
    const msg = (err?.message ?? "").toLowerCase();
    const isMethodNotFound = msg.includes("method not found") || msg.includes("-32601") || msg.includes("discover") || msg.includes("unsupported protocol version") || msg.includes("era negotiation");
    if (isMethodNotFound) {
      try { return await attempt("legacy"); } catch (legacyErr) { throw legacyErr; }
    }
    throw err;
  }
}
