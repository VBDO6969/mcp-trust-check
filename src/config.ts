/**
 * Layer 1 configuration — single config object for all tunable constants.
 * Values are proposals not from MCP spec where noted.
 */
export const CONFIG = {
  /** Maximum allowed description length (chars). Proposal, not from MCP spec. */
  DESCRIPTION_MAX_LENGTH: 2000,

  /** Base64-like blob detection threshold (chars). 64 is proposed (not from spec);
   *  32 would false-positive on hashes/identifiers. */
  BASE64_MIN_LENGTH: 64,

  /** Baseline file schema version. Increment on breaking change; unknown version => clear error. */
  SCHEMA_VERSION: 1 as const,

  /** Related-baseline overlap threshold. Proposal (0.5), not from any spec.
   *  Overlap = |common names| / min(|current|, |baseline|). Related if >= 0.5. */
  RELATED_OVERLAP_THRESHOLD: 0.5,

  /** Standard top-level Tool fields per installed SDK ToolSchema (core@2.4.0, spec 2026-07-28).
   *  Derived from schemas-CzwpZ9-S.d.cts ToolSchema. Any other top-level field is non-standard
   *  (e.g. x_hidden) => warning, but IS included in hash (documented decision).
   *  Do not change without re-reading installed SDK types. */
  STANDARD_TOOL_FIELDS: new Set([
    "name",
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "execution",
    "_meta",
    "icons",
  ]),

  /** Reviewer: Baseten API timeout per attempt (ms). Proposal, not from spec. */
  REVIEWER_TIMEOUT_MS: 60_000 as const,

  /** Reviewer: max serialized tool definition length (chars) before refusing to send. Proposal. */
  REVIEWER_MAX_SERIALIZED_LENGTH: 30_000 as const,

  /** Reviewer: max reason length after cleaning (chars). Proposal. */
  REVIEWER_REASON_MAX_LENGTH: 300 as const,

  /** Reviewer: retry delays for 429/5xx/network/timeout (ms). Proposal. */
  REVIEWER_RETRY_DELAYS_MS: [1_000, 2_000] as const,
} as const;
