import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Per-server baseline path — fixes the "single baseline.json overwrites" bug.
 * Example from user: approve weather-server, then approve github-server should NOT forget weather.
 *
 * We store one file per server, keyed by the exact spawn command.
 * - Default: hash of `command + \0 + args.join(\0)` → baselines/<hash>.json
 * - Optional human alias: --name <id> → baselines/<sanitized-name>.json
 *
 * Using hash of the spawn command is deterministic and avoids collisions.
 * For hackathon we keep it simple: project-local ./baselines/ (portable, gitignored).
 * Later we can support XDG: ~/.config/mcp-trust-check/baselines/ if needed.
 */
export function getBaselinePath(
  command: string,
  args: string[],
  opts: { name?: string; dir?: string } = {}
): string {
  const dir = opts.dir ?? "baselines";
  if (opts.name) {
    // Sanitize name: only allow a-zA-Z0-9-_., no path traversal
    const safe = opts.name.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 64);
    if (!safe) throw new Error(`Invalid --name "${opts.name}": must contain alphanumeric characters`);
    return join(dir, `${safe}.json`);
  }
  // Hash the canonical spawn identity: command + \0 + args.join(\0)
  // Using \0 as separator avoids ambiguity between ["a b", "c"] and ["a", "b c"]
  const canonical = `${command}\0${args.join("\0")}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16); // 16 hex chars = 64 bits, enough for hackathon
  return join(dir, `${hash}.json`);
}

/**
 * For display / testing: show how the hash is derived.
 * Example: "npx tsx src/weather-server.ts" → baselines/a1b2c3d4e5f6g7h8.json
 */
export function getBaselineInfo(command: string, args: string[], opts: { name?: string; dir?: string } = {}) {
  return {
    path: getBaselinePath(command, args, opts),
    hash: opts.name ? undefined : createHash("sha256").update(`${command}\0${args.join("\0")}`).digest("hex").slice(0, 16),
    name: opts.name,
    canonical: `${command}\0${args.join("\0")}`,
  };
}
