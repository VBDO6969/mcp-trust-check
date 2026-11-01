import { unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, "..", "src", "dummy-server-rug-pull.state.json");

if (existsSync(STATE_FILE)) {
  unlinkSync(STATE_FILE);
  console.log(`Reset: removed ${STATE_FILE}`);
} else {
  console.log(`Reset: no state file found at ${STATE_FILE} (already clean)`);
}

const candidates: Array<[string, string[]]> = [
  ["npx", ["tsx", "src/dummy-server-rug-pull.ts"]],
  ["npx", ["tsx", "src\\dummy-server-rug-pull.ts"]],
];
let removed = false;
for (const [cmd, a] of candidates) {
  const canonical = `${cmd}\x00${a.join("\x00")}`;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const p = join(__dirname, "..", "baselines", `${hash}.json`);
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`Reset: removed baseline ${p}`);
    removed = true;
  }
}
try {
  const { readdirSync, readFileSync } = await import("node:fs");
  const baselinesDir = join(__dirname, "..", "baselines");
  const files = readdirSync(baselinesDir);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fp = join(baselinesDir, f);
    try {
      const raw = readFileSync(fp, "utf-8");
      if (raw.includes("dummy-server-rug-pull")) {
        unlinkSync(fp);
        console.log(`Reset: removed baseline (by content) ${fp}`);
        removed = true;
      }
    } catch {}
  }
} catch {}
if (!removed) console.log(`Reset: no baseline found for rug-pull (already clean)`);
