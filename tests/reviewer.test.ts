import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reviewTool, ReviewerError } from "../src/reviewer.ts";
import { CONFIG } from "../src/config.ts";
import { canonicalize } from "../src/canonicalize.ts";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.BASETEN_API_KEY;

function setKey(key: string | undefined) {
  if (key === undefined) delete process.env.BASETEN_API_KEY;
  else process.env.BASETEN_API_KEY = key;
}

function mockResponse(status: number, body: unknown, opts: { ok?: boolean } = {}): Response {
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: new Headers(),
  } as unknown as Response;
}

function mockOuter(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { content, ...extra } }],
  };
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  setKey(ORIGINAL_KEY);
});

beforeEach(() => {
  setKey("test-key-for-reviewer");
});

describe("reviewer – mocked fetch", () => {
  it("valid JSON content", async () => {
    global.fetch = async () =>
      mockResponse(200, mockOuter(JSON.stringify({ suspicious: true, reason: "bad tool" })));
    const res = await reviewTool({ name: "t", description: "x", inputSchema: { type: "object" } });
    assert.equal(res.suspicious, true);
    assert.equal(res.reason, "bad tool");
  });

  it("JSON surrounded by extra text", async () => {
    const content = 'Here is the result: {"suspicious": false, "reason": "looks safe"} thanks';
    global.fetch = async () => mockResponse(200, mockOuter(content));
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(res.suspicious, false);
    assert.equal(res.reason, "looks safe");
  });

  it("reasoning_content containing different verdict is ignored", async () => {
    const content = JSON.stringify({ suspicious: false, reason: "safe" });
    global.fetch = async () =>
      mockResponse(200, mockOuter(content, { reasoning_content: JSON.stringify({ suspicious: true, reason: "evil" }) } as any));
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(res.suspicious, false);
    assert.equal(res.reason, "safe");
  });

  it("invalid first response then valid (retry works)", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) {
        return mockResponse(200, mockOuter("not json at all {"));
      }
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: true, reason: "second try" })));
    };
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(calls, 2);
    assert.equal(res.suspicious, true);
  });

  it("3 invalid responses throw", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse(200, mockOuter("invalid json {{{"));
    };
    await assert.rejects(() => reviewTool({ name: "t", inputSchema: { type: "object" } }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      return true;
    });
    assert.equal(calls, 3);
  });

  it("401 does not retry", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse(401, { error: "unauthorized" });
    };
    await assert.rejects(() => reviewTool({ name: "a", inputSchema: { type: "object" } }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      assert.match(e.message, /401/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("500 then success", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return mockResponse(500, { error: "server" });
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "ok after retry" })));
    };
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(calls, 2);
    assert.equal(res.reason, "ok after retry");
  });

  it("timeout throws", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      throw err;
    };
    await assert.rejects(() => reviewTool({ name: "t", inputSchema: { type: "object" } }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      return true;
    });
    assert.equal(calls, 3);
  });
  it("missing key throws", async () => {
    setKey(undefined);
    await assert.rejects(() => reviewTool({ name: "t" }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      assert.match(e.message, /BASETEN_API_KEY/);
      return true;
    });
  });

  it("reason with ANSI codes and 1000 chars is cleaned and truncated", async () => {
    const long = "a".repeat(1000);
    const ansiReason = "\u001b[31mhello\u001b[0m \n\t " + long + " \x00\x1F";
    global.fetch = async () => mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: ansiReason })));
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(res.reason.includes("\u001b"), false);
    assert.equal(res.reason.includes("\x00"), false);
    assert.equal(res.reason.length, 300);
    assert.ok(res.reason.startsWith("hello"));
    assert.equal(res.reason.includes("  "), false);
  });

  it("oversize definition throws", async () => {
    const big = "x".repeat(40000);
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "ok" })));
    };
    await assert.rejects(() => reviewTool({ name: "big", description: big, inputSchema: { type: "object" } }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      assert.match(e.message, /too large/i);
      return true;
    });
    assert.equal(fetchCalled, false);
  });

  it("delimiter never appears inside the data", async () => {
    let capturedBody: any = null;
    global.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body as string);
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "ok" })));
    };
    const tool = { name: "t", description: "test", inputSchema: { type: "object" } };
    await reviewTool(tool);
    const userContent: string = capturedBody.messages[1].content as string;
    const systemContent: string = capturedBody.messages[0].content as string;
    const firstLine = userContent.split("\n")[0];
    assert.match(firstLine, /^<<<DATA-[a-f0-9]{32}>>>$/);
    const serialized = canonicalize({ name: "t", description: "test", inputSchema: { type: "object" } });
    assert.equal(serialized.includes(firstLine), false);
    assert.ok(systemContent.includes(firstLine));
  });

  it("key never appears in any thrown error message", async () => {
    const secret = "super-secret-key-12345-UNIQUE";
    setKey(secret);
    global.fetch = async () => mockResponse(500, { error: "fail" });
    await assert.rejects(() => reviewTool({ name: "t", inputSchema: { type: "object" } }), (e: any) => {
      assert.ok(e instanceof ReviewerError);
      assert.equal(e.message.includes(secret), false, "error should not contain key");
      return true;
    });
    global.fetch = async () => mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "ok" }), { reasoning_content: secret } as any));
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(res.reason.includes(secret), false);
  });

  it("icons[].src is replaced with [omitted] before sending", async () => {
    let capturedBody: any = null;
    global.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body as string);
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "ok" })));
    };
    const tool = {
      name: "t",
      inputSchema: { type: "object" },
      icons: [{ src: "https://example.com/secret.png", width: 100 }],
    };
    await reviewTool(tool as any);
    const userContent: string = capturedBody.messages[1].content as string;
    assert.ok(userContent.includes("[omitted]"));
    assert.equal(userContent.includes("https://example.com/secret.png"), false);
  });

  it("other 4xx (400) does not retry", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse(400, { error: "bad request" });
    };
    await assert.rejects(() => reviewTool({ name: "t", inputSchema: { type: "object" } }), (e: any) => {
      assert.match(e.message, /400/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("429 retries", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return mockResponse(429, { error: "rate limit" });
      return mockResponse(200, mockOuter(JSON.stringify({ suspicious: false, reason: "after 429" })));
    };
    const res = await reviewTool({ name: "t", inputSchema: { type: "object" } });
    assert.equal(calls, 2);
    assert.equal(res.reason, "after 429");
  });

  it("empty content retries then throws", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return mockResponse(200, mockOuter(""));
    };
    await assert.rejects(() => reviewTool({ name: "t", inputSchema: { type: "object" } }));
    assert.equal(calls, 3);
  });
});

