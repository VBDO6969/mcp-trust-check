import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTools } from "../src/validate.ts";
import { CONFIG } from "../src/config.ts";

function cleanTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "get_weather",
    description: "Get current weather for a city",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City name" } } },
    ...overrides,
  };
}

describe("validateTools", () => {
  it("clean tool -> no findings", () => {
    const r = validateTools([cleanTool()]);
    assert.equal(r.valid, true);
    assert.equal(r.findings.length, 0);
  });
  it("name non-empty string -> error", () => {
    const r = validateTools([{ ...cleanTool(), name: "" }]);
    assert.equal(r.valid, false);
    assert.ok(r.findings.some((f) => f.code === "NAME_NOT_STRING"));
  });
  it("name missing -> error", () => {
    const { name: _n, ...rest } = cleanTool();
    const r = validateTools([rest]);
    assert.ok(r.findings.some((f) => f.code === "NAME_NOT_STRING"));
  });
  it("description not string -> error", () => {
    const r = validateTools([cleanTool({ description: 123 as unknown as string })]);
    assert.ok(r.findings.some((f) => f.code === "DESCRIPTION_NOT_STRING"));
  });
  it("description too long -> error", () => {
    const long = "a".repeat(CONFIG.DESCRIPTION_MAX_LENGTH + 1);
    const r = validateTools([cleanTool({ description: long })]);
    assert.ok(r.findings.some((f) => f.code === "DESCRIPTION_TOO_LONG"));
  });
  it("description exactly at cap -> valid", () => {
    const long = "a".repeat(CONFIG.DESCRIPTION_MAX_LENGTH);
    const r = validateTools([cleanTool({ description: long })]);
    assert.ok(!r.findings.some((f) => f.code === "DESCRIPTION_TOO_LONG"));
  });
  it("inputSchema missing -> error", () => {
    const { inputSchema: _i, ...rest } = cleanTool();
    const r = validateTools([rest]);
    assert.ok(r.findings.some((f) => f.code === "MISSING_INPUT_SCHEMA"));
  });
  it("inputSchema not object -> error", () => {
    const r = validateTools([cleanTool({ inputSchema: "notobj" as unknown as Record<string, unknown> })]);
    assert.ok(r.findings.some((f) => f.code === "INPUT_SCHEMA_NOT_OBJECT"));
  });
  it("inputSchema.type !== object -> error", () => {
    const r = validateTools([cleanTool({ inputSchema: { type: "string" as unknown as string } })]);
    assert.ok(r.findings.some((f) => f.code === "INPUT_SCHEMA_TYPE_NOT_OBJECT"));
  });
  it("duplicate tool names -> error", () => {
    const r = validateTools([cleanTool({ name: "dup" }), cleanTool({ name: "dup" })]);
    assert.ok(r.findings.some((f) => f.code === "DUPLICATE_TOOL_NAME"));
  });
  it("non-standard top-level field -> warning, included", () => {
    const r = validateTools([cleanTool({ x_hidden: "secret" })]);
    assert.ok(r.findings.some((f) => f.code === "NON_STANDARD_FIELD" && f.severity === "warning"));
    assert.equal(r.valid, true);
  });
  it("standard fields do not trigger warning", () => {
    const tool = cleanTool({ title: "t", _meta: { a: 1 }, annotations: { title: "x" }, icons: [{ src: "https://example.com/icon.png" }] });
    const r = validateTools([tool]);
    assert.ok(!r.findings.some((f) => f.code === "NON_STANDARD_FIELD"));
  });
});

describe("validateTools hidden content", () => {
  it("zero-width U+200B -> error with fieldPath", () => {
    const r = validateTools([cleanTool({ description: "hello\u200Bworld" })]);
    const f = r.findings.find((x) => x.code === "HIDDEN_ZERO_WIDTH");
    assert.ok(f, "should detect zero-width");
    assert.ok(f!.fieldPath.includes("description"));
    assert.ok(f!.message.includes("U+200B"));
    assert.equal(f!.severity, "error");
  });
  it("zero-width in nested inputSchema property description", () => {
    const tool = cleanTool({
      inputSchema: {
        type: "object",
        properties: { city: { type: "string", description: "bad\u200Cdesc" } },
      },
    });
    const r = validateTools([tool]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_ZERO_WIDTH" && f.fieldPath.includes("inputSchema.properties.city.description")));
  });
  it("zero-width in non-standard field x_hidden", () => {
    const tool = cleanTool({ x_hidden: "evil\uFEFF" });
    const r = validateTools([tool]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_ZERO_WIDTH" && f.fieldPath === "x_hidden"));
  });
  it("bidi control U+202E -> error", () => {
    const r = validateTools([cleanTool({ description: "hello\u202Eworld" })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_BIDI_CONTROL" && f.message.includes("U+202E")));
  });
  it("bidi via U+200E -> error", () => {
    const r = validateTools([cleanTool({ description: "\u200E" })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_BIDI_CONTROL"));
  });
  it("unicode tag char U+E0001 -> error", () => {
    const tagChar = String.fromCodePoint(0xe0001);
    const r = validateTools([cleanTool({ description: `hello${tagChar}world` })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_UNICODE_TAG"));
  });
  it("HTML comment -> error", () => {
    const r = validateTools([cleanTool({ description: "hello <!-- hidden --> world" })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_HTML_COMMENT"));
  });
  it("markdown comment %% -> error", () => {
    const r = validateTools([cleanTool({ description: "hello %% hidden %% world" })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_MARKDOWN_COMMENT"));
  });
  it("base64 blob len 64 -> error", () => {
    const blob = "A".repeat(64);
    const r = validateTools([cleanTool({ description: `prefix ${blob} suffix` })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_BASE64_BLOB"));
  });
  it("base64 blob len 63 -> not error (threshold 64)", () => {
    const blob = "A".repeat(63);
    const r = validateTools([cleanTool({ description: `prefix ${blob} suffix` })]);
    assert.ok(!r.findings.some((f) => f.code === "HIDDEN_BASE64_BLOB"));
  });
  it("icons[].src with base64 data URI -> not flagged", () => {
    const blob = "A".repeat(100);
    const tool = cleanTool({ icons: [{ src: `data:image/png;base64,${blob}` }] });
    const r = validateTools([tool]);
    assert.ok(!r.findings.some((f) => f.code === "HIDDEN_BASE64_BLOB" && f.fieldPath.includes("icons")));
  });
  it("base64 blob in non-icons field still flagged", () => {
    const blob = "A".repeat(64);
    const r = validateTools([cleanTool({ description: blob })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_BASE64_BLOB"));
  });
  it("never prints full hidden payload - excerpt bounded", () => {
    const payload = "x".repeat(200) + "\u200B" + "y".repeat(200);
    const r = validateTools([cleanTool({ description: payload })]);
    const f = r.findings.find((x) => x.code === "HIDDEN_ZERO_WIDTH")!;
    assert.ok(f.message.length < payload.length);
    assert.ok(!f.message.includes("y".repeat(200)));
  });
  it("markdown comment [//]: # -> error", () => {
    const r = validateTools([cleanTool({ description: "hello [//]: # (hidden) world" })]);
    assert.ok(r.findings.some((f) => f.code === "HIDDEN_MARKDOWN_COMMENT"));
  });
  it("normal description without markdown comment passes", () => {
    const r = validateTools([cleanTool({ description: "hello world with [brackets] and (paren) but no comment" })]);
    assert.ok(!r.findings.some((f) => f.code === "HIDDEN_MARKDOWN_COMMENT"));
  });
});
