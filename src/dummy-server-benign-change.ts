import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getBaselineExists(): boolean {
  try {
    const baselinesDir = join(__dirname, "..", "baselines");
    const candidates: Array<[string, string[]]> = [
      ["npx", ["tsx", "src/dummy-server-benign-change.ts"]],
      ["npx", ["tsx", "src\\dummy-server-benign-change.ts"]],
    ];
    for (const [cmd, a] of candidates) {
      const canonical = `${cmd}\x00${a.join("\x00")}`;
      const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
      const p = join(baselinesDir, `${hash}.json`);
      if (existsSync(p)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const isV2 = getBaselineExists();
const descV1 = "Get current weather for a city";
const descV2 = "Get current weather for a city (v2 benign update)";

serveStdio(() => {
  const server = new McpServer({ name: "dummy-benign-change", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "get_weather",
    { description: isV2 ? descV2 : descV1, inputSchema: z.object({ city: z.string().describe("City name") }) },
    async ({ city }) => ({ content: [{ type: "text", text: `Weather in ${city}: sunny` }] })
  );
  return server;
});
console.error(`dummy-server-benign-change started (${isV2 ? "v2" : "v1"})`);
