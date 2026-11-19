import type { AdoClient } from "../client.js";

export interface RawTestRun {
  id: number;
  name: string;
  state?: string;
  totalTests?: number;
  passedTests?: number;
  unanalyzedTests?: number;
  incompleteTests?: number;
  notApplicableTests?: number;
  runStatistics?: { outcome: string; count: number; state?: string }[];
  startedDate?: string;
  completedDate?: string;
  webAccessUrl?: string;
}

export interface RawTestResult {
  id: number;
  testCaseTitle?: string;
  automatedTestName?: string;
  automatedTestStorage?: string;
  outcome?: string; // Passed | Failed | NotExecuted | Inconclusive | Aborted | ...
  errorMessage?: string;
  stackTrace?: string;
  durationInMs?: number;
  testRun?: { id: string; name?: string };
}

export function buildUri(buildId: number): string {
  return `vstfs:///Build/Build/${buildId}`;
}

export async function listTestRuns(client: AdoClient, buildId: number): Promise<RawTestRun[]> {
  return client.list<RawTestRun>("_apis/test/runs", { buildUri: buildUri(buildId), includeRunDetails: true }, 500);
}

/** Results of one test run, optionally filtered by outcomes (e.g. "Failed,Aborted"). Pages with $skip. */
export async function listTestResults(
  client: AdoClient,
  runId: number,
  opts: { outcomes?: string; limit?: number } = {},
): Promise<RawTestResult[]> {
  const limit = opts.limit ?? 1000;
  const pageSize = Math.min(1000, limit);
  const out: RawTestResult[] = [];
  for (let skip = 0; out.length < limit; skip += pageSize) {
    const { data } = await client.getJson<{ value: RawTestResult[] }>(`_apis/test/Runs/${runId}/results`, {
      outcomes: opts.outcomes,
      $top: pageSize,
      $skip: skip,
    });
    const page = data.value ?? [];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out.slice(0, limit);
}

export function runCounts(run: RawTestRun) {
  const stats: Record<string, number> = {};
  for (const s of run.runStatistics ?? []) stats[s.outcome] = (stats[s.outcome] ?? 0) + s.count;
  const total = run.totalTests ?? Object.values(stats).reduce((a, b) => a + b, 0);
  const passed = stats.Passed ?? run.passedTests ?? 0;
  const failed = (stats.Failed ?? 0) + (stats.Aborted ?? 0) + (stats.Error ?? 0) + (stats.Timeout ?? 0);
  return { total, passed, failed, other: Math.max(0, total - passed - failed), byOutcome: stats };
}
