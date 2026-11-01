import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { CONFIG } from "./config.js";

/**
 * Per-server baseline path — fixes the "single baseline.json overwrites" bug.
 * Example from user: approve weather-server, then approve github-server should NOT forget weather.
 * We store one file per server, keyed by the exact spawn command.
 * - Default: hash of `command + \\0 + args.join(\\0)` → baselines/<hash>.json
 * - Optional human alias: --name <id> → baselines/<sanitized-name>.json
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
    const safe = opts.name.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 64);
    if (!safe) throw new Error(`Invalid --name "${opts.name}": must contain alphanumeric characters`);
    return join(dir, `${safe}.json`);
  }
  // Normalize slashes for cross-platform consistent hashing (Windows uses \ vs /)
  const normCommand = command.replace(/\\/g, "/");
  const normArgs = args.map((a) => a.replace(/\\/g, "/"));
  const canonical = `${normCommand}\0${normArgs.join("\0")}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(dir, `${hash}.json`);
}

export function getBaselineInfo(command: string, args: string[], opts: { name?: string; dir?: string } = {}) {
  const normCommand = command.replace(/\\/g, "/");
  const normArgs = args.map((a) => a.replace(/\\/g, "/"));
  return {
    path: getBaselinePath(command, args, opts),
    hash: opts.name ? undefined : createHash("sha256").update(`${normCommand}\0${normArgs.join("\0")}`).digest("hex").slice(0, 16),
    name: opts.name,
    canonical: `${normCommand}\0${normArgs.join("\0")}`,
  };
}

export interface BaselineToolEntry {
  name: string;
  hash: string;
  definition: Record<string, unknown>;
}

export interface BaselineFile {
  schemaVersion: number;
  savedAt: string;
  command: string;
  args: string[];
  lifecycle: string;
  protocolVersion?: string;
  aggregateHash: string;
  previousKey?: string;
  tools: BaselineToolEntry[];
}

export interface RelatedBaseline {
  fileName: string;
  path: string;
  baseline: BaselineFile;
  overlap: number;
  commonNames: string[];
}

export async function readBaseline(filePath: string): Promise<BaselineFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw new Error(`Failed to read baseline ${filePath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Corrupted baseline file ${filePath}: invalid JSON — ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("schemaVersion" in (parsed as Record<string, unknown>))) {
    throw new Error(`Corrupted baseline file ${filePath}: missing schemaVersion`);
  }
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== CONFIG.SCHEMA_VERSION) {
    throw new Error(
      `Unknown baseline schemaVersion ${String(p.schemaVersion)} in ${filePath} (expected ${CONFIG.SCHEMA_VERSION}) — file may be from newer CLI`
    );
  }
  return parsed as BaselineFile;
}

export async function writeBaselineAtomic(filePath: string, data: BaselineFile): Promise<void> {
  const parent = filePath.replace(/[/\\][^/\\]+$/, "");
  if (parent && parent !== filePath) {
    await mkdir(parent, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(data, null, 2);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

export async function findRelatedBaselines(
  currentToolNames: string[],
  opts: { dir?: string; excludePath?: string } = {}
): Promise<{ related: RelatedBaseline[]; warnings: string[] }> {
  const dir = opts.dir ?? "baselines";
  const warnings: string[] = [];
  const related: RelatedBaseline[] = [];
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { related: [], warnings };
    warnings.push(`Warning: could not read baselines directory ${dir}: ${(e as Error).message}`);
    return { related, warnings };
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  for (const f of jsonFiles) {
    const fullPath = join(dir, f);
    if (opts.excludePath && fullPath === opts.excludePath) continue;
    let baseline: BaselineFile | null;
    try {
      baseline = await readBaseline(fullPath);
    } catch (e) {
      warnings.push(`Warning: skipping unreadable baseline ${f}: ${(e as Error).message}`);
      continue;
    }
    if (!baseline) continue;
    const baselineNames = baseline.tools.map((t) => t.name);
    const common = currentToolNames.filter((n) => baselineNames.includes(n));
    const denom = Math.min(currentToolNames.length, baselineNames.length);
    if (denom === 0) continue;
    const overlap = common.length / denom;
    if (overlap >= CONFIG.RELATED_OVERLAP_THRESHOLD) {
      related.push({ fileName: f, path: fullPath, baseline, overlap, commonNames: common });
    }
  }
  related.sort((a, b) => b.overlap - a.overlap);
  return { related, warnings };
}

export function checkIdentity(baseline: BaselineFile, currentCommand: string, currentArgs: string[]): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const oldCmd = baseline.command;
  const oldArgs = baseline.args ?? [];
  const sameCommand = norm(oldCmd) === norm(currentCommand) && JSON.stringify(oldArgs.map(norm)) === JSON.stringify(currentArgs.map(norm));
  if (!sameCommand) {
    return `launch command changed since approval: was "${oldCmd} ${oldArgs.join(" ")}" now "${currentCommand} ${currentArgs.join(" ")}"`;
  }
  return null;
}
