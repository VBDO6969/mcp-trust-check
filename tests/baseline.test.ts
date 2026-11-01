import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBaseline, writeBaselineAtomic, findRelatedBaselines, getBaselinePath } from "../src/baseline.ts";

const TEST_DIR = "baselines/__test_tmp_baseline";

before(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});
after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("baseline roundtrip", () => {
  it("write and read back", async () => {
    const p = join(TEST_DIR, "roundtrip.json");
    const data = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      command: "npx",
      args: ["tsx", "src/dummy-server.ts"],
      lifecycle: "modern",
      protocolVersion: "2026-07-28",
      aggregateHash: "abc123",
      tools: [{ name: "get_weather", hash: "h1", definition: { name: "get_weather", inputSchema: { type: "object" } } }],
    };
    await writeBaselineAtomic(p, data as unknown as import("../src/baseline.ts").BaselineFile);
    const read = await readBaseline(p);
    assert.equal(read?.command, "npx");
    assert.equal(read?.aggregateHash, "abc123");
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

describe("findRelatedBaselines", () => {
  it("corrupted file inside baselines/ does not crash", async () => {
    const dir = join(TEST_DIR, "related_test");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "good.json"), JSON.stringify({
      schemaVersion: 1, savedAt: new Date().toISOString(), command: "npx", args: ["a"], lifecycle: "modern", aggregateHash: "h", tools: [{ name: "get_weather", hash: "x", definition: { name: "get_weather" } }],
    }));
    await writeFile(join(dir, "bad.json"), "{ corrupted", "utf-8");
    const { related, warnings } = await findRelatedBaselines(["get_weather"], { dir });
    assert.ok(related.length >= 0);
    assert.ok(warnings.some((w) => w.includes("bad.json")));
  });
  it("overlap >=0.5 is related", async () => {
    const dir = join(TEST_DIR, "overlap_test");
    await mkdir(dir, { recursive: true });
    // Baseline with 2 tools, current with 2 overlapping 1 -> overlap 0.5
    await writeFile(join(dir, "baseline1.json"), JSON.stringify({
      schemaVersion: 1, savedAt: new Date().toISOString(), command: "npx", args: ["a"], lifecycle: "modern", aggregateHash: "h",
      tools: [{ name: "a", hash: "h1", definition: { name: "a" } }, { name: "b", hash: "h2", definition: { name: "b" } }],
    }));
    const { related } = await findRelatedBaselines(["a", "c"], { dir });
    assert.ok(related.length > 0, "overlap 1/2=0.5 should be related");
  });
  it("overlap <0.5 not related", async () => {
    const dir = join(TEST_DIR, "overlap_low");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "baseline1.json"), JSON.stringify({
      schemaVersion: 1, savedAt: new Date().toISOString(), command: "npx", args: ["a"], lifecycle: "modern", aggregateHash: "h",
      tools: [{ name: "a", hash: "h1", definition: { name: "a" } }, { name: "b", hash: "h2", definition: { name: "b" } }, { name: "c", hash: "h3", definition: { name: "c" } }],
    }));
    // current has 1 tool "x" common 0 => 0/1=0
    const { related } = await findRelatedBaselines(["x"], { dir });
    assert.equal(related.length, 0);
  });
});
