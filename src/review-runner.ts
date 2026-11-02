import { CONFIG } from "./config.js";
import { ReviewerError, reviewTool } from "./reviewer.js";

export async function reviewTools(
  tools: Record<string, unknown>[],
  reviewFn: typeof reviewTool = reviewTool,
  opts?: { concurrency?: number; deadlineMs?: number }
): Promise<Array<{ name: string; suspicious: boolean; reason: string }>> {
  const concurrency = opts?.concurrency ?? CONFIG.REVIEW_CONCURRENCY;
  const deadlineMs = opts?.deadlineMs ?? CONFIG.REVIEW_DEADLINE_MS;

  if (tools.length === 0) return [];

  const results: Array<{ name: string; suspicious: boolean; reason: string } | undefined> = new Array(tools.length);
  let nextIndex = 0;
  let rejected = false;
  let firstError: unknown = null;
  let deadlineFired = false;
  let deadlineTimer: NodeJS.Timeout | null = null;

  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      reject(new ReviewerError("Review exceeded overall deadline"));
    }, deadlineMs);
    if (deadlineTimer && typeof (deadlineTimer as any).unref === "function") (deadlineTimer as any).unref();
  });

  async function worker(): Promise<void> {
    while (true) {
      if (rejected || deadlineFired) return;
      const idx = nextIndex++;
      if (idx >= tools.length) return;
      if (deadlineFired) {
        if (!firstError) firstError = new ReviewerError("Review exceeded overall deadline");
        rejected = true;
        return;
      }
      if (rejected) return;
      const tool = tools[idx];
      const name = typeof (tool as any).name === "string" ? (tool as any).name : "<unknown>";
      try {
        const res = await reviewFn(tool);
        if (rejected || deadlineFired) return;
        results[idx] = { name, suspicious: res.suspicious, reason: res.reason };
      } catch (e) {
        if (!rejected && !deadlineFired) {
          rejected = true;
          firstError = e;
          throw e;
        }
        return;
      }
    }
  }

  const workers: Promise<void>[] = [];
  const numWorkers = Math.min(concurrency, tools.length);
  for (let i = 0; i < numWorkers; i++) workers.push(worker());

  try {
    await Promise.race([Promise.all(workers), deadlinePromise]);
  } catch (e) {
    rejected = true;
    if (!firstError) firstError = e;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    throw firstError;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  if (firstError) throw firstError;
  if (deadlineFired) throw new ReviewerError("Review exceeded overall deadline");

  return results as Array<{ name: string; suspicious: boolean; reason: string }>;
}
