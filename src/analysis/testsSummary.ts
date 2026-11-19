import type { AdoClient } from "../client.js";
import { listTestResults, listTestRuns, runCounts, type RawTestResult } from "../api/tests.js";
import { mapLimit, truncateLines, truncateText } from "../util.js";

export interface CompactTestResult {
  name: string;
  fullName?: string;
  outcome?: string;
  run?: string;
  durationMs?: number;
  errorMessage?: string;
  stackTrace?: string;
}

export interface TestSummary {
  buildId: number;
  hasTests: boolean;
  totals: { total: number; passed: number; failed: number; other: number };
  runs: { id: number; name: string; state?: string; total: number; passed: number; failed: number }[];
  results: CompactTestResult[];
  omittedResults?: number;
}

export interface TestSummaryOptions {
  outcomes?: string; // ADO outcome list, default "Failed,Aborted,Error,Timeout"
  top?: number;
  maxStackLines?: number;
  maxMessageChars?: number;
}

export const FAILED_OUTCOMES = "Failed,Aborted,Error,Timeout";

export function compactResult(r: RawTestResult, runName: string | undefined, opts: TestSummaryOptions = {}): CompactTestResult {
  return {
    name: r.testCaseTitle ?? r.automatedTestName ?? `result ${r.id}`,
    fullName: r.automatedTestName && r.automatedTestName !== r.testCaseTitle ? r.automatedTestName : undefined,
    outcome: r.outcome,
    run: runName,
    durationMs: r.durationInMs !== undefined ? Math.round(r.durationInMs) : undefined,
    errorMessage: truncateText(r.errorMessage?.trim() || undefined, opts.maxMessageChars ?? 800),
    stackTrace: truncateLines(r.stackTrace?.trim() || undefined, opts.maxStackLines ?? 12),
  };
}

export function testKey(r: RawTestResult): string {
  return (r.automatedTestName ?? r.testCaseTitle ?? String(r.id)).toLowerCase();
}

export async function getTestSummary(client: AdoClient, buildId: number, opts: TestSummaryOptions = {}): Promise<TestSummary> {
  const top = opts.top ?? 50;
  const outcomes = opts.outcomes === "all" ? undefined : (opts.outcomes ?? FAILED_OUTCOMES);
  const runs = await listTestRuns(client, buildId);
  const runRows = runs.map((r) => ({ id: r.id, name: r.name, state: r.state, ...runCounts(r) }));
  const totals = runRows.reduce(
    (t, r) => ({ total: t.total + r.total, passed: t.passed + r.passed, failed: t.failed + r.failed, other: t.other + r.other }),
    { total: 0, passed: 0, failed: 0, other: 0 },
  );

  // Only fetch results from runs that can contain matching outcomes.
  const relevant = outcomes === FAILED_OUTCOMES ? runRows.filter((r) => r.failed > 0) : runRows;
  const perRun = await mapLimit(relevant, 4, async (run) => {
    const results = await listTestResults(client, run.id, { outcomes, limit: top + 1 });
    return results.map((r) => ({ r, runName: run.name }));
  });
  const all = perRun.flat();

  return {
    buildId,
    hasTests: runs.length > 0,
    totals,
    runs: runRows.map(({ id, name, state, total, passed, failed }) => ({ id, name, state, total, passed, failed })),
    results: all.slice(0, top).map(({ r, runName }) => compactResult(r, runName, opts)),
    omittedResults: all.length > top ? Math.max(all.length - top, totals.failed - top) : undefined,
  };
}

/** Set of failed test keys in a build (cheap: only fetches failed results). */
export async function failedTestKeys(client: AdoClient, buildId: number, limit = 2000): Promise<{ keys: Map<string, RawTestResult>; hasTests: boolean }> {
  const runs = await listTestRuns(client, buildId);
  const keys = new Map<string, RawTestResult>();
  const failing = runs.filter((r) => runCounts(r).failed > 0);
  const perRun = await mapLimit(failing, 4, (run) => listTestResults(client, run.id, { outcomes: FAILED_OUTCOMES, limit }));
  for (const r of perRun.flat()) keys.set(testKey(r), r);
  return { keys, hasTests: runs.length > 0 };
}
