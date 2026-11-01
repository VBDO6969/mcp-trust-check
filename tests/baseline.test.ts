import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBaseline, writeBaselineAtomic, findRelatedBaselines, getBaselinePath } from "../src/baseline.ts";
import { hashTool, aggregateHash } from "../src/canonicalize.ts";

const TEST_DIR = "baselines/__test_tmp_baseline";

before(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});
after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function makeBaselineData(defs: Record<string, unknown>[], command = "npx", args: string[] = ["tsx", "src/dummy-server.ts"]) {
  const perTool = defs.map((def) => {
    const name = (def as Record<string, unknown>).name as string;
    return { name, hash: hashTool(def), definition: def as Record<string, unknown> };
  });
  const agg = aggregateHash(perTool.map((p) => ({ name: p.name, hash: p.hash })));
  return {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    command,
    args,
    lifecycle: "modern",
    protocolVersion: "2026-07-28",
    aggregateHash: agg,
    tools: perTool,
  } as import("../src/baseline.ts").BaselineFile;
}

describe("baseline roundtrip", () => {
  it("write and read back", async () => {
    const p = join(TEST_DIR, "roundtrip.json");
    const def = { name: "get_weather", inputSchema: { type: "object" } };
    const h = hashTool(def);
    const agg = aggregateHash([{ name: "get_weather", hash: h }]);
    const data = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      command: "npx",
      args: ["tsx", "src/dummy-server.ts"],
      lifecycle: "modern",
      protocolVersion: "2026-07-28",
      aggregateHash: agg,
      tools: [{ name: "get_weather", hash: h, definition: def }],
    };
    await writeBaselineAtomic(p, data as unknown as import("../src/baseline.ts").BaselineFile);
    const read = await readBaseline(p);
    assert.equal(read?.command, "npx");
    assert.equal(read?.aggregateHash, agg);
    assert.equal(read?.tools.length, 1);
  });
  it("missing -> null", async () => {
    const r = await readBaseline(join(TEST_DIR, "does_not_exist_12345.json"));
    assert.equal(r, null);
  });
  it("corrupted JSON -> clear error", async () => {
    const p = join(TEST_DIR, "corrupted.json");
    await writeFile(p, "{ not json", "utf-8");
    await assert.rejects(() => readBaseline(p), /Corrupted.*invalid JSON/i);
  });
  it("unknown schemaVersion -> clear error", async () => {
    const p = join(TEST_DIR, "badversion.json");
    await writeFile(p, JSON.stringify({ schemaVersion: 999, tools: [] }), "utf-8");
    await assert.rejects(() => readBaseline(p), /Unknown baseline schemaVersion/i);
  });
});

describe("baseline integrity verification", () => {
  it("untouched roundtrip passes", async () => {
    const p = join(TEST_DIR, "integrity_roundtrip.json");
    const data = makeBaselineData([{ name: "get_weather", description: "nice", inputSchema: { type: "object" } }]);
    await writeBaselineAtomic(p, data);
    const read = await readBaseline(p);
    assert.ok(read);
    assert.equal(read.tools[0].name, "get_weather");
  });
  it("changed definition with old hash -> throws", async () => {
    const p = join(TEST_DIR, "integrity_tamper_def.json");
    const def = { name: "get_weather", description: "original", inputSchema: { type: "object" } };
    const data = makeBaselineData([def]);
    await writeBaselineAtomic(p, data);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.tools[0].definition.description = "tampered malicious instruction";
    await writeFile(p, JSON.stringify(raw, null, 2), "utf-8");
    await assert.rejects(() => readBaseline(p), /Baseline integrity check failed.*tool get_weather.*definition does not match its stored hash/i);
  });
  it("changed tool hash -> throws", async () => {
    const p = join(TEST_DIR, "integrity_tamper_hash.json");
    const def = { name: "get_weather", description: "original", inputSchema: { type: "object" } };
    const data = makeBaselineData([def]);
    await writeBaselineAtomic(p, data);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.tools[0].hash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await writeFile(p, JSON.stringify(raw, null, 2), "utf-8");
    await assert.rejects(() => readBaseline(p), /Baseline integrity check failed.*tool get_weather/i);
  });

  it("changed aggregateHash -> throws", async () => {
    const p = join(TEST_DIR, "integrity_tamper_agg.json");
    const def = { name: "get_weather", description: "original", inputSchema: { type: "object" } };
    const data = makeBaselineData([def]);
    await writeBaselineAtomic(p, data);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.aggregateHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await writeFile(p, JSON.stringify(raw, null, 2), "utf-8");
    await assert.rejects(() => readBaseline(p), /Baseline integrity check failed.*aggregate/i);
  });
  it("tampered baseline error does not print definition contents", async () => {
    const p = join(TEST_DIR, "integrity_no_leak.json");
    const secret = "SECRET_INSTRUCTION_SHOULD_NOT_LEAK_12345";
    const def = { name: "get_weather", description: secret, inputSchema: { type: "object" } };
    const data = makeBaselineData([def]);
    await writeBaselineAtomic(p, data);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.tools[0].definition.description = "tampered";
    await writeFile(p, JSON.stringify(raw, null, 2), "utf-8");
    await assert.rejects(
      () => readBaseline(p),
      (err: Error) => {
        assert.match(err.message, /Baseline integrity check failed/);
        assert.equal(err.message.includes(secret), false, "error should not leak definition contents");
        return true;
      }
    );
  });
});

describe("findRelatedBaselines", () => {
  it("corrupted file inside baselines/ does not crash", async () => {
    const dir = join(TEST_DIR, "related_test");
    await mkdir(dir, { recursive: true });
    const good = makeBaselineData([{ name: "get_weather", inputSchema: { type: "object" } }], "npx", ["a"]);
    await writeFile(join(dir, "good.json"), JSON.stringify(good));
    await writeFile(join(dir, "bad.json"), "{ corrupted", "utf-8");
    const { related, warnings } = await findRelatedBaselines(["get_weather"], { dir });
    assert.ok(related.length >= 0);
    assert.ok(warnings.some((w) => w.includes("bad.json")));
  });
  it("tampered file inside baselines/ is skipped with warning and does not crash", async () => {
    const dir = join(TEST_DIR, "tampered_related_test");
    await mkdir(dir, { recursive: true });
    const goodDef = { name: "get_weather", description: "good", inputSchema: { type: "object" } };
    const good = makeBaselineData([goodDef], "npx", ["a"]);
    await writeFile(join(dir, "good.json"), JSON.stringify(good));
    const tamperedDef = { name: "get_weather", description: "original", inputSchema: { type: "object" } };
    const tampered = makeBaselineData([tamperedDef], "npx", ["b"]);
    const tamperedPath = join(dir, "tampered.json");
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const raw = JSON.parse(await readFile(tamperedPath, "utf-8"));
    raw.tools[0].definition.description = "evil tampered";
    await writeFile(tamperedPath, JSON.stringify(raw), "utf-8");
    const { related, warnings } = await findRelatedBaselines(["get_weather"], { dir });
    assert.ok(warnings.some((w) => w.includes("tampered.json") && w.includes("Baseline integrity check failed")));
    assert.ok(related.some((r) => r.fileName === "good.json"));
  });
  it("overlap >=0.5 is related", async () => {
    const dir = join(TEST_DIR, "overlap_test");
    await mkdir(dir, { recursive: true });
    const defA = { name: "a", inputSchema: { type: "object" } };
    const defB = { name: "b", inputSchema: { type: "object" } };
    const baseline = makeBaselineData([defA, defB], "npx", ["a"]);
    await writeFile(join(dir, "baseline1.json"), JSON.stringify(baseline));
    const { related } = await findRelatedBaselines(["a", "c"], { dir });
    assert.ok(related.length > 0, "overlap 1/2=0.5 should be related");
  });
  it("overlap <0.5 not related", async () => {
    const dir = join(TEST_DIR, "overlap_low");
    await mkdir(dir, { recursive: true });
    const defA = { name: "a", inputSchema: { type: "object" } };
    const defB = { name: "b", inputSchema: { type: "object" } };
    const defC = { name: "c", inputSchema: { type: "object" } };
    const baseline = makeBaselineData([defA, defB, defC], "npx", ["a"]);
    await writeFile(join(dir, "baseline1.json"), JSON.stringify(baseline));
    const { related } = await findRelatedBaselines(["x"], { dir });
    assert.equal(related.length, 0);
  });
});
