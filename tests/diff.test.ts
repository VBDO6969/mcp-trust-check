import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffTools } from "../src/diff.ts";

describe("diffTools", () => {
  it("added", () => {
    const base: Record<string, unknown>[] = [{ name: "a", description: "x", inputSchema: { type: "object" } }];
    const cur: Record<string, unknown>[] = [
      { name: "a", description: "x", inputSchema: { type: "object" } },
      { name: "b", description: "y", inputSchema: { type: "object" } },
    ];
    const d = diffTools(base, cur);
    assert.deepEqual(d.added, ["b"]);
    assert.deepEqual(d.removed, []);
    assert.equal(d.changed.length, 0);
  });
  it("removed", () => {
    const base: Record<string, unknown>[] = [
      { name: "a", description: "x", inputSchema: { type: "object" } },
      { name: "b", description: "y", inputSchema: { type: "object" } },
    ];
    const cur: Record<string, unknown>[] = [{ name: "a", description: "x", inputSchema: { type: "object" } }];
    const d = diffTools(base, cur);
    assert.deepEqual(d.removed, ["b"]);
    assert.deepEqual(d.added, []);
  });
  it("changed top-level field", () => {
    const base: Record<string, unknown>[] = [{ name: "a", description: "old", inputSchema: { type: "object" } }];
    const cur: Record<string, unknown>[] = [{ name: "a", description: "new", inputSchema: { type: "object" } }];
    const d = diffTools(base, cur);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].name, "a");
    assert.ok(d.changed[0].changes.some((c) => c.fieldPath === "description" && c.oldValue === "old" && c.newValue === "new"));
  });
  it("unchanged not listed", () => {
    const base: Record<string, unknown>[] = [{ name: "a", description: "x", inputSchema: { type: "object" } }];
    const cur: Record<string, unknown>[] = [{ name: "a", description: "x", inputSchema: { type: "object" } }];
    const d = diffTools(base, cur);
    assert.equal(d.added.length, 0);
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 0);
    assert.deepEqual(d.unchanged, ["a"]);
  });
  it("changed nested inputSchema", () => {
    const b: Record<string, unknown>[] = [{ name: "a", inputSchema: { type: "object", properties: { city: { type: "string", description: "old" } } } }];
    const c: Record<string, unknown>[] = [{ name: "a", inputSchema: { type: "object", properties: { city: { type: "string", description: "new" } } } }];
    const d = diffTools(b, c);
    assert.equal(d.changed.length, 1);
    assert.ok(d.changed[0].changes.some((x) => x.fieldPath.includes("inputSchema.properties.city.description")));
  });
  it("multiple changes", () => {
    const base: Record<string, unknown>[] = [
      { name: "a", description: "old", inputSchema: { type: "object" } },
      { name: "b", description: "x", inputSchema: { type: "object" } },
    ];
    const cur: Record<string, unknown>[] = [
      { name: "a", description: "new", inputSchema: { type: "object" } },
      { name: "c", description: "z", inputSchema: { type: "object" } },
    ];
    const d = diffTools(base, cur);
    assert.deepEqual(d.added, ["c"]);
    assert.deepEqual(d.removed, ["b"]);
    assert.equal(d.changed.length, 1);
  });
});
