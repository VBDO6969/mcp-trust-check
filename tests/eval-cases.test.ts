import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const casesPath = path.resolve("scripts/eval/cases.json");

describe("eval-cases", () => {
  it("cases.json parses", () => {
    const raw = fs.readFileSync(casesPath, "utf8");
    const data = JSON.parse(raw);
    assert.ok(Array.isArray(data), "cases.json must be an array");
    assert.ok(data.length >= 20, `expected at least 20 cases, got ${data.length}`);
  });

  it("ids unique, labels and difficulty valid", () => {
    const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    const ids = new Set<string>();
    const validLabels = new Set(["benign", "malicious"]);
    const validDiff = new Set(["easy", "hard"]);
    for (const c of data) {
      assert.ok(typeof c.id === "string" && c.id.length > 0, `missing id in ${JSON.stringify(c)}`);
      assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
      ids.add(c.id);
      assert.ok(validLabels.has(c.label), `invalid label ${c.label} in ${c.id}`);
      assert.ok(validDiff.has(c.difficulty), `invalid difficulty ${c.difficulty} in ${c.id}`);
      assert.ok(typeof c.why === "string" && c.why.length > 0, `missing why in ${c.id}`);
      assert.ok(c.tool && typeof c.tool === "object", `missing tool in ${c.id}`);
    }
  });

  it("at least 10 of each label", () => {
    const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    const benign = data.filter((c: any) => c.label === "benign").length;
    const malicious = data.filter((c: any) => c.label === "malicious").length;
    assert.ok(benign >= 10, `expected at least 10 benign, got ${benign}`);
    assert.ok(malicious >= 10, `expected at least 10 malicious, got ${malicious}`);
  });

  it("every tool has non-empty string name and object inputSchema", () => {
    const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    for (const c of data) {
      const t = c.tool as any;
      assert.ok(typeof t.name === "string" && t.name.trim().length > 0, `tool name missing or empty in ${c.id}`);
      assert.ok(t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema), `inputSchema must be object in ${c.id}`);
      assert.equal(t.inputSchema.type, "object", `inputSchema.type must be object in ${c.id}`);
      // properties should be object if present, each with description
      if (t.inputSchema.properties) {
        assert.ok(typeof t.inputSchema.properties === "object" && !Array.isArray(t.inputSchema.properties), `properties must be object in ${c.id}`);
        for (const [pname, prop] of Object.entries(t.inputSchema.properties as Record<string, any>)) {
          assert.ok(prop && typeof prop === "object", `property ${pname} must be object in ${c.id}`);
          assert.ok(typeof (prop as any).type === "string", `property ${pname} missing type in ${c.id}`);
          // description should exist for each property per spec ("with typed properties and their own descriptions")
          assert.ok(typeof (prop as any).description === "string" && (prop as any).description.length > 0, `property ${pname} missing description in ${c.id}`);
        }
      }
      // tool description should be non-empty string
      assert.ok(typeof t.description === "string" && t.description.length > 0, `tool description missing in ${c.id}`);
    }
  });

  it("coverage: at least 4 benign hard, at least 4 malicious hard, at least 1 description over 1500 chars", () => {
    const data = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    const benignHard = data.filter((c: any) => c.label === "benign" && c.difficulty === "hard").length;
    const maliciousHard = data.filter((c: any) => c.label === "malicious" && c.difficulty === "hard").length;
    assert.ok(benignHard >= 4, `expected at least 4 benign hard, got ${benignHard}`);
    assert.ok(maliciousHard >= 4, `expected at least 4 malicious hard, got ${maliciousHard}`);
    const longDesc = data.filter((c: any) => typeof c.tool.description === "string" && c.tool.description.length > 1500);
    assert.ok(longDesc.length >= 1, `expected at least 1 description over 1500 chars, got ${longDesc.length}`);
  });
});
