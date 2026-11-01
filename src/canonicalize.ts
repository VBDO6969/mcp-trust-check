import { createHash } from "node:crypto";

/**
 * Canonicalize a JSON value for stable hashing.
 * - Recursively sorts object keys lexicographically.
 * - Keeps array order (arrays are ordered data).
 * - Throws on non-JSON values: undefined, functions, symbols, NaN, Infinity, -Infinity.
 * - Preserves null, boolean, number (finite), string.
 *
 * This is NOT full RFC 8785 (JCS):
 * - JCS also normalizes number encoding (e.g. -0, exponentials), mandates UTF-8,
 *   escapes specific Unicode, and sorts more strictly.
 * - For our use case (hashing MCP tool definitions that are already JSON-serializable
 *   objects with string/number/boolean/null/array/object), recursive key sorting +
 *   JSON.stringify is sufficient: it guarantees that two semantically identical tool
 *   objects with different key insertion orders hash identically, while remaining
 *   simple and auditable. Full JCS would add complexity for no practical security gain
 *   here, as MCP tool definitions are not adversarial JSON with exotic number forms.
 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  function sortRec(v: unknown): unknown {
    if (v === null) return null;
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw new Error(`canonicalize: non-finite number not allowed: ${String(v)}`);
      }
      // JSON.stringify preserves -0 as "0" which is fine; JCS would normalize but we keep simple.
      return v;
    }
    if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") {
      throw new Error(`canonicalize: non-JSON value not allowed: ${typeof v}`);
    }
    if (typeof v === "bigint") {
      throw new Error(`canonicalize: bigint not allowed`);
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error("canonicalize: circular reference detected");
      seen.add(v);
      const out = (v as unknown[]).map((el) => sortRec(el));
      seen.delete(v);
      return out;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new Error("canonicalize: circular reference detected");
      seen.add(obj);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = sortRec(obj[k]);
      }
      seen.delete(obj);
      return sorted;
    }
    throw new Error(`canonicalize: unsupported type ${typeof v}`);
  }
  const sorted = sortRec(value);
  return JSON.stringify(sorted);
}

/**
 * SHA-256 hex digest via node:crypto.
 */
export function sha256Hex(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf-8").digest("hex");
}

/**
 * Hash a single tool (full raw tool object, including non-standard fields).
 * Non-standard fields ARE included (warning in validate, but hashed).
 */
export function hashTool(tool: unknown): string {
  const canonical = canonicalize(tool);
  return sha256Hex(canonical);
}

/**
 * Aggregate hash over sorted (name, toolHash) list.
 * Deterministic regardless of input order; includes non-standard fields via per-tool hashes.
 */
export function aggregateHash(namedHashes: Array<{ name: string; hash: string }>): string {
  const sorted = [...namedHashes].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = canonicalize(sorted);
  return sha256Hex(canonical);
}

/**
 * Convenience: compute per-tool hashes and aggregate in one call.
 */
export function hashTools(tools: unknown[]): {
  perTool: Array<{ name: string; hash: string }>;
  aggregateHash: string;
} {
  const perTool = tools.map((t) => {
    const name = (t as Record<string, unknown>).name;
    const hash = hashTool(t);
    return { name: typeof name === "string" ? name : "<unknown>", hash };
  });
  const agg = aggregateHash(perTool);
  return { perTool, aggregateHash: agg };
}
