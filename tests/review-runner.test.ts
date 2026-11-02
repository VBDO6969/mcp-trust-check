import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewTools } from "../src/review-runner.ts";
import { ReviewerError } from "../src/reviewer.ts";

describe("review-runner", () => {
  it("order preserved", async () => {
    const tools = [
      { name: "a", inputSchema: { type: "object" } },
      { name: "b", inputSchema: { type: "object" } },
      { name: "c", inputSchema: { type: "object" } },
    ];
    const delays = [30, 10, 20];
    const reviewFn = async (tool: Record<string, unknown>) => {
      const idx = ["a", "b", "c"].indexOf((tool as any).name);
      await new Promise((r) => setTimeout(r, delays[idx]));
      return { suspicious: false, reason: `ok-${(tool as any).name}` };
    };
    const res = await reviewTools(tools as any, reviewFn as any, { concurrency: 2 });
    assert.deepEqual(
      res.map((r) => r.name),
      ["a", "b", "c"]
    );
    assert.deepEqual(
      res.map((r) => r.reason),
      ["ok-a", "ok-b", "ok-c"]
    );
  });

  it("in-flight count never exceeds concurrency 2", async () => {
    const tools = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
    let inFlight = 0;
    let maxInFlight = 0;
    const reviewFn = async (tool: Record<string, unknown>) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { suspicious: false, reason: "ok" };
    };
    const res = await reviewTools(tools as any, reviewFn as any, { concurrency: 2 });
    assert.equal(res.length, 6);
    assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} exceeds 2`);
    assert.ok(maxInFlight === 2, "should reach concurrency limit");
  });

  it("first error rejects", async () => {
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    let started: string[] = [];
    const reviewFn = async (tool: Record<string, unknown>) => {
      const name = (tool as any).name;
      started.push(name);
      if (name === "b") throw new Error("fail b");
      await new Promise((r) => setTimeout(r, 30));
      return { suspicious: false, reason: "ok" };
    };
    await assert.rejects(() => reviewTools(tools as any, reviewFn as any, { concurrency: 2 }), (e: any) => {
      assert.match(e.message, /fail b/);
      return true;
    });
    // c may or may not have started depending on timing, but b error should cause rejection
    assert.ok(started.includes("a") && started.includes("b"));
  });

  it("tiny deadline rejects and stops starting new calls", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
    let started = 0;
    const reviewFn = async (tool: Record<string, unknown>) => {
      started++;
      await new Promise((r) => setTimeout(r, 100));
      return { suspicious: false, reason: "ok" };
    };
    await assert.rejects(
      () => reviewTools(tools as any, reviewFn as any, { concurrency: 1, deadlineMs: 50 }),
      (e: any) => {
        assert.ok(e instanceof ReviewerError);
        assert.match(e.message, /deadline/i);
        return true;
      }
    );
    // With deadline 50ms and concurrency 1, at most 1 tool should have started (maybe 0-1)
    assert.ok(started < tools.length, `started ${started} should be less than ${tools.length} due to deadline`);
  });

  it("name fallback to <unknown> when not string", async () => {
    const tools: any[] = [{ inputSchema: { type: "object" } }, { name: 123, inputSchema: { type: "object" } }];
    const reviewFn = async (tool: Record<string, unknown>) => ({ suspicious: false, reason: "ok" });
    const res = await reviewTools(tools as any, reviewFn as any, { concurrency: 2 });
    assert.equal(res[0].name, "<unknown>");
    assert.equal(res[1].name, "<unknown>");
  });
});
