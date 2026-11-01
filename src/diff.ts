export interface ChangedField {
  fieldPath: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ChangedTool {
  name: string;
  changes: ChangedField[];
}

export interface DiffResult {
  added: string[];
  removed: string[];
  changed: ChangedTool[];
  unchanged: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    for (const k of ak) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

function collectChanges(oldVal: unknown, newVal: unknown, basePath: string, out: ChangedField[]): void {
  if (deepEqual(oldVal, newVal)) return;
  // If both are plain objects, recurse per key
  if (isPlainObject(oldVal) && isPlainObject(newVal)) {
    const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    for (const k of allKeys) {
      const childPath = basePath ? `${basePath}.${k}` : k;
      const hasOld = k in (oldVal as Record<string, unknown>);
      const hasNew = k in (newVal as Record<string, unknown>);
      if (!hasOld || !hasNew) {
        out.push({
          fieldPath: childPath,
          oldValue: hasOld ? (oldVal as Record<string, unknown>)[k] : undefined,
          newValue: hasNew ? (newVal as Record<string, unknown>)[k] : undefined,
        });
      } else {
        collectChanges(
          (oldVal as Record<string, unknown>)[k],
          (newVal as Record<string, unknown>)[k],
          childPath,
          out
        );
      }
    }
    return;
  }
  // Arrays: compare index-wise, but also report added/removed indices
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const maxLen = Math.max(oldVal.length, newVal.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${basePath}[${i}]`;
      if (i >= oldVal.length) {
        out.push({ fieldPath: childPath, oldValue: undefined, newValue: newVal[i] });
      } else if (i >= newVal.length) {
        out.push({ fieldPath: childPath, oldValue: oldVal[i], newValue: undefined });
      } else {
        collectChanges(oldVal[i], newVal[i], childPath, out);
      }
    }
    return;
  }
  // Primitive or type mismatch
  out.push({ fieldPath: basePath, oldValue: oldVal, newValue: newVal });
}

/**
 * Pure diff: compare baseline tools vs current by name.
 * Unchanged tools are not listed in detail but returned in `unchanged` for completeness.
 */
export function diffTools(
  baselineTools: Array<Record<string, unknown>>,
  currentTools: Array<Record<string, unknown>>
): DiffResult {
  const baselineMap = new Map<string, Record<string, unknown>>();
  for (const t of baselineTools) {
    const name = (t as Record<string, unknown>).name as string | undefined;
    if (typeof name === "string") baselineMap.set(name, t);
  }
  const currentMap = new Map<string, Record<string, unknown>>();
  for (const t of currentTools) {
    const name = (t as Record<string, unknown>).name as string | undefined;
    if (typeof name === "string") currentMap.set(name, t);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedTool[] = [];
  const unchanged: string[] = [];

  for (const [name, cur] of currentMap) {
    if (!baselineMap.has(name)) {
      added.push(name);
    } else {
      const base = baselineMap.get(name)!;
      if (deepEqual(base, cur)) {
        unchanged.push(name);
      } else {
        const changes: ChangedField[] = [];
        // Collect all field paths that differ, starting from root
        collectChanges(base, cur, "", changes);
        // Filter out empty basePath entry if recursion already produced children
        // If root objects differ only via nested fields, we will have child entries.
        // If they were equal we'd have returned above, so here we have changes.
        changed.push({ name, changes });
      }
    }
  }
  for (const [name] of baselineMap) {
    if (!currentMap.has(name)) removed.push(name);
  }
  return { added, removed, changed, unchanged };
}

/**
 * Human-readable formatting for CLI output.
 */
export function formatDiff(diff: DiffResult): string {
  const lines: string[] = [];
  if (diff.added.length) lines.push(`Added tools: ${diff.added.join(", ")}`);
  if (diff.removed.length) lines.push(`Removed tools: ${diff.removed.join(", ")}`);
  if (diff.changed.length) {
    lines.push(`Changed tools:`);
    for (const c of diff.changed) {
      lines.push(`  - ${c.name}:`);
      for (const ch of c.changes) {
        const oldStr = JSON.stringify(ch.oldValue);
        const newStr = JSON.stringify(ch.newValue);
        lines.push(`      ${ch.fieldPath}: ${oldStr} => ${newStr}`);
      }
    }
  }
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("No differences.");
  }
  return lines.join("\n");
}
