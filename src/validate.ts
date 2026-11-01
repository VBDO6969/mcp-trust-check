import { CONFIG } from "./config.js";

export interface Finding {
  toolName: string;
  fieldPath: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}
export interface ValidateResult {
  valid: boolean;
  findings: Finding[];
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/;
const MARKDOWN_COMMENT_RE = /%%[\s\S]*?%%|\[comment\]:\s*#\s*\(|\[\/\/\]:\s*#/i;

function hasZeroWidth(s: string): { found: boolean; codePoint?: string } {
  const m = s.match(ZERO_WIDTH_RE);
  if (!m) return { found: false };
  const cp = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
  return { found: true, codePoint: `U+${cp}` };
}
function hasBidi(s: string): { found: boolean; codePoint?: string } {
  const m = s.match(BIDI_RE);
  if (!m) return { found: false };
  const cp = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
  return { found: true, codePoint: `U+${cp}` };
}
function hasTagChars(s: string): { found: boolean; codePoint?: string } {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) return { found: true, codePoint: `U+${cp.toString(16).toUpperCase()}` };
  }
  return { found: false };
}
function hasHtmlComment(s: string): boolean { return HTML_COMMENT_RE.test(s); }
function hasMarkdownComment(s: string): boolean { return MARKDOWN_COMMENT_RE.test(s); }
function hasBase64Blob(s: string, threshold: number): { found: boolean; excerpt?: string } {
  const re = new RegExp(`[A-Za-z0-9+/=]{${threshold},}`);
  const m = s.match(re);
  if (!m) return { found: false };
  const excerpt = m[0].slice(0, 20) + (m[0].length > 20 ? "\u2026" : "") + ` (len=${m[0].length})`;
  return { found: true, excerpt };
}
function excerptBounded(s: string, max = 30): string {
  const preview = s.slice(0, max).replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return preview + (s.length > max ? "\u2026" : "");
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateTools(rawTools: unknown[]): ValidateResult {
  const findings: Finding[] = [];
  const seenNames = new Map<string, number>();
  if (!Array.isArray(rawTools)) {
    findings.push({ toolName: "<unknown>", fieldPath: "", severity: "error", code: "TOOLS_NOT_ARRAY", message: "tools is not an array" });
    return { valid: false, findings };
  }
  for (let idx = 0; idx < rawTools.length; idx++) {
    const raw = rawTools[idx] as Record<string, unknown>;
    const toolNameRaw = isPlainObject(raw) ? raw["name"] : undefined;
    const toolNameForFinding = typeof toolNameRaw === "string" && toolNameRaw.length > 0 ? toolNameRaw : `<tool[${idx}]>`;
    if (!isPlainObject(raw)) {
      findings.push({ toolName: toolNameForFinding, fieldPath: `[${idx}]`, severity: "error", code: "TOOL_NOT_OBJECT", message: "tool entry is not an object" });
      continue;
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      findings.push({ toolName: toolNameForFinding, fieldPath: "name", severity: "error", code: "NAME_NOT_STRING", message: "name must be a non-empty string" });
    } else {
      const count = seenNames.get(raw.name) ?? 0;
      if (count >= 1) findings.push({ toolName: raw.name, fieldPath: "name", severity: "error", code: "DUPLICATE_TOOL_NAME", message: `duplicate tool name "${raw.name}"` });
      seenNames.set(raw.name, count + 1);
    }
    if ("description" in raw && raw.description !== undefined && raw.description !== null) {
      if (typeof raw.description !== "string") findings.push({ toolName: toolNameForFinding, fieldPath: "description", severity: "error", code: "DESCRIPTION_NOT_STRING", message: "description must be a string if present" });
      else if (raw.description.length > CONFIG.DESCRIPTION_MAX_LENGTH) findings.push({ toolName: toolNameForFinding, fieldPath: "description", severity: "error", code: "DESCRIPTION_TOO_LONG", message: `description exceeds ${CONFIG.DESCRIPTION_MAX_LENGTH} chars (got ${raw.description.length})` });
    }
    if (!("inputSchema" in raw) || raw.inputSchema === undefined || raw.inputSchema === null) {
      findings.push({ toolName: toolNameForFinding, fieldPath: "inputSchema", severity: "error", code: "MISSING_INPUT_SCHEMA", message: 'inputSchema is required and must be an object with type "object"' });
    } else if (!isPlainObject(raw.inputSchema)) {
      findings.push({ toolName: toolNameForFinding, fieldPath: "inputSchema", severity: "error", code: "INPUT_SCHEMA_NOT_OBJECT", message: "inputSchema must be an object" });
    } else {
      const is = raw.inputSchema as Record<string, unknown>;
      if (is["type"] !== "object") findings.push({ toolName: toolNameForFinding, fieldPath: "inputSchema.type", severity: "error", code: "INPUT_SCHEMA_TYPE_NOT_OBJECT", message: `inputSchema.type must be "object" (got ${JSON.stringify(is["type"])})` });
      if ("properties" in is && is.properties !== undefined && is.properties !== null && !isPlainObject(is.properties)) findings.push({ toolName: toolNameForFinding, fieldPath: "inputSchema.properties", severity: "error", code: "INPUT_SCHEMA_PROPERTIES_NOT_OBJECT", message: "inputSchema.properties must be an object if present" });
      if ("required" in is && is.required !== undefined && is.required !== null && (!Array.isArray(is.required) || !is.required.every((x) => typeof x === "string"))) findings.push({ toolName: toolNameForFinding, fieldPath: "inputSchema.required", severity: "error", code: "INPUT_SCHEMA_REQUIRED_NOT_STRING_ARRAY", message: "inputSchema.required must be an array of strings if present" });
      if ("outputSchema" in raw && raw.outputSchema !== undefined && raw.outputSchema !== null && !isPlainObject(raw.outputSchema)) findings.push({ toolName: toolNameForFinding, fieldPath: "outputSchema", severity: "error", code: "OUTPUT_SCHEMA_NOT_OBJECT", message: "outputSchema must be an object if present" });
      if ("annotations" in raw && raw.annotations !== undefined && raw.annotations !== null) {
        if (!isPlainObject(raw.annotations)) findings.push({ toolName: toolNameForFinding, fieldPath: "annotations", severity: "error", code: "ANNOTATIONS_NOT_OBJECT", message: "annotations must be an object if present" });
        else {
          const ann = raw.annotations as Record<string, unknown>;
          for (const k of ["title"]) if (k in ann && ann[k] !== undefined && typeof ann[k] !== "string") findings.push({ toolName: toolNameForFinding, fieldPath: `annotations.${k}`, severity: "error", code: "ANNOTATIONS_FIELD_NOT_STRING", message: `annotations.${k} must be a string if present` });
          for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (k in ann && ann[k] !== undefined && typeof ann[k] !== "boolean") findings.push({ toolName: toolNameForFinding, fieldPath: `annotations.${k}`, severity: "error", code: "ANNOTATIONS_FIELD_NOT_BOOLEAN", message: `annotations.${k} must be a boolean if present` });
          const allowedAnn = new Set(["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
          for (const k of Object.keys(ann)) if (!allowedAnn.has(k)) findings.push({ toolName: toolNameForFinding, fieldPath: `annotations.${k}`, severity: "warning", code: "NON_STANDARD_ANNOTATION_FIELD", message: `non-standard annotations field "${k}" (warning, included in hash)` });
        }
      }
      if ("execution" in raw && raw.execution !== undefined && raw.execution !== null) {
        if (!isPlainObject(raw.execution)) findings.push({ toolName: toolNameForFinding, fieldPath: "execution", severity: "error", code: "EXECUTION_NOT_OBJECT", message: "execution must be an object if present" });
        else {
          const exec = raw.execution as Record<string, unknown>;
          if ("taskSupport" in exec && exec.taskSupport !== undefined) { const v = exec.taskSupport; if (v !== "optional" && v !== "required" && v !== "forbidden") findings.push({ toolName: toolNameForFinding, fieldPath: "execution.taskSupport", severity: "error", code: "EXECUTION_TASK_SUPPORT_INVALID", message: `execution.taskSupport must be one of "optional","required","forbidden" (got ${JSON.stringify(v)})` }); }
        }
      }
      if ("_meta" in raw && raw._meta !== undefined && raw._meta !== null && !isPlainObject(raw._meta)) findings.push({ toolName: toolNameForFinding, fieldPath: "_meta", severity: "error", code: "META_NOT_OBJECT", message: "_meta must be an object if present" });
      if ("icons" in raw && raw.icons !== undefined && raw.icons !== null) {
        if (!Array.isArray(raw.icons)) findings.push({ toolName: toolNameForFinding, fieldPath: "icons", severity: "error", code: "ICONS_NOT_ARRAY", message: "icons must be an array if present" });
        else {
          for (let i = 0; i < (raw.icons as unknown[]).length; i++) {
            const ic = (raw.icons as Record<string, unknown>[])[i];
            if (!isPlainObject(ic)) { findings.push({ toolName: toolNameForFinding, fieldPath: `icons[${i}]`, severity: "error", code: "ICON_NOT_OBJECT", message: `icons[${i}] must be an object` }); continue; }
            if (typeof ic["src"] !== "string" || (ic["src"] as string).trim() === "") findings.push({ toolName: toolNameForFinding, fieldPath: `icons[${i}].src`, severity: "error", code: "ICON_SRC_NOT_STRING", message: `icons[${i}].src must be a non-empty string` });
            if ("mimeType" in ic && ic["mimeType"] !== undefined && typeof ic["mimeType"] !== "string") findings.push({ toolName: toolNameForFinding, fieldPath: `icons[${i}].mimeType`, severity: "error", code: "ICON_MIMETYPE_NOT_STRING", message: `icons[${i}].mimeType must be a string if present` });
            if ("theme" in ic && ic["theme"] !== undefined && ic["theme"] !== "light" && ic["theme"] !== "dark") findings.push({ toolName: toolNameForFinding, fieldPath: `icons[${i}].theme`, severity: "error", code: "ICON_THEME_INVALID", message: `icons[${i}].theme must be "light" or "dark" if present` });
          }
        }
      }
      if ("title" in raw && raw.title !== undefined && raw.title !== null && typeof raw.title !== "string") findings.push({ toolName: toolNameForFinding, fieldPath: "title", severity: "error", code: "TITLE_NOT_STRING", message: "title must be a string if present" });
    }
    for (const key of Object.keys(raw)) if (!CONFIG.STANDARD_TOOL_FIELDS.has(key)) findings.push({ toolName: toolNameForFinding, fieldPath: key, severity: "warning", code: "NON_STANDARD_FIELD", message: `non-standard top-level field "${key}" (warning, included in hash)` });
    function scanStrings(value: unknown, fieldPath: string) {
      if (typeof value === "string") {
        const isIconsSrc = /^icons\[\d+\]\.src$/.test(fieldPath);
        const checkBase64 = !isIconsSrc;
        const zw = hasZeroWidth(value); if (zw.found) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_ZERO_WIDTH", message: `hidden zero-width character ${zw.codePoint} at ${fieldPath} excerpt="${excerptBounded(value)}"` });
        const bidi = hasBidi(value); if (bidi.found) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_BIDI_CONTROL", message: `hidden bidi control ${bidi.codePoint} at ${fieldPath} excerpt="${excerptBounded(value)}"` });
        const tag = hasTagChars(value); if (tag.found) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_UNICODE_TAG", message: `hidden Unicode tag char ${tag.codePoint} at ${fieldPath} excerpt="${excerptBounded(value)}"` });
        if (hasHtmlComment(value)) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_HTML_COMMENT", message: `hidden HTML comment at ${fieldPath} excerpt="${excerptBounded(value)}"` });
        if (hasMarkdownComment(value)) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_MARKDOWN_COMMENT", message: `hidden markdown comment at ${fieldPath} excerpt="${excerptBounded(value)}"` });
        if (checkBase64) { const b64 = hasBase64Blob(value, CONFIG.BASE64_MIN_LENGTH); if (b64.found) findings.push({ toolName: toolNameForFinding, fieldPath, severity: "error", code: "HIDDEN_BASE64_BLOB", message: `long base64-like blob at ${fieldPath} excerpt="${b64.excerpt}"` }); }
        return;
      }
      if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const childPath = fieldPath ? `${fieldPath}[${i}]` : `[${i}]`; scanStrings(value[i], childPath); } return; }
      if (isPlainObject(value)) { for (const [k, v] of Object.entries(value)) { const childPath = fieldPath ? `${fieldPath}.${k}` : k; scanStrings(v, childPath); } }
    }
    scanStrings(raw, "");
  }
  const hasError = findings.some((f) => f.severity === "error");
  return { valid: !hasError, findings };
}
