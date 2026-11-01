import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, hashTool, aggregateHash, sha256Hex } from "../src/canonicalize.ts";

describe("canonicalize", () => {
  it("key-order independence at every depth", () => {
    const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
    const b = { a: 1, b: 2, nested: { x: 1, y: 2 } };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(hashTool(a), hashTool(b));
  });
  it("array order sensitivity", () => {
    const a = { arr: [1, 2, 3] };
    const b = { arr: [3, 2, 1] };
    assert.notEqual(canonicalize(a), canonicalize(b));
    assert.notEqual(hashTool(a), hashTool(b));
  });
  it("deep nested order independence", () => {
    const a = { l1: { l2: { c: 3, b: 2, a: 1 } } };
    const b = { l1: { l2: { a: 1, b: 2, c: 3 } } };
    assert.equal(canonicalize(a), canonicalize(b));
  });
  it("throw on undefined", () => {
    assert.throws(() => canonicalize({ a: undefined }), /non-JSON/);
  });
  it("throw on NaN", () => {
    assert.throws(() => canonicalize(NaN), /non-finite/);
  });
  it("throw on Infinity", () => {
    assert.throws(() => canonicalize(Infinity), /non-finite/);
  });
  it("throw on function", () => {
    assert.throws(() => canonicalize({ a: () => {} }), /non-JSON/);
  });
  it("aggregateHash order independence", () => {
    const listA = [{ name: "b", hash: "hashB" }, { name: "a", hash: "hashA" }];
    const listB = [{ name: "a", hash: "hashA" }, { name: "b", hash: "hashB" }];
    assert.equal(aggregateHash(listA), aggregateHash(listB));
  });
  it("aggregateHash different content -> different hash", () => {
    const listA = [{ name: "a", hash: "hashA" }];
    const listB = [{ name: "a", hash: "hashA2" }];
    assert.notEqual(aggregateHash(listA), aggregateHash(listB));
  });
  it("sha256 hex is deterministic", () => {
    const c = canonicalize({ a: 1 });
    const h1 = sha256Hex(c);
    const h2 = sha256Hex(c);
    assert.equal(h1, h2);
    assert.ok(/^[a-f0-9]{64}$/.test(h1));
  });
});
