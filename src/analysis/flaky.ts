import type { AdoClient } from "../client.js";
import { listBuilds } from "../api/builds.js";
import type { RawTestResult } from "../api/tests.js";
import { failedTestKeys } from "./testsSummary.js";
import { mapLimit, truncateText } from "../util.js";

export interface FlakyOptions {
  runs?: number; // how many recent completed runs to inspect
  branch?: string;
  top?: number; // how many tests to report
  minFailures?: number;
}

export interface BuildTestFailures {
  buildId: number;
  hasTests: boolean;
  failed: Map<string, RawTestResult>;
}

/**
 * Flakiness heuristic over runs that produced test results (newest first):
 *  - a test is "intermittent" if it failed in some runs and did not fail in others;
 *  - `flips` counts pass↔fail transitions in chronological order. Many flips mean flaky;
 *    one flip at the newest end means a recent regression (or a fix).
 * Not-failing is treated as passing; failed results are the only ones fetched, which keeps this cheap.
 */
export function scoreFlaky(builds: BuildTestFailures[], opts: { top?: number; minFailures?: number } = {}) {
  const withTests = builds.filter((b) => b.hasTests);
  const tests = new Map<string, { sample: RawTestResult; history: boolean[] }>();
  withTests.forEach((b, i) => {
    for (const [k, r] of b.failed) {
      const t = tests.get(k) ?? { sample: r, history: new Array(withTests.length).fill(false) };
      t.history[i] = true;
      tests.set(k, t);
    }
  });

  const rows = [...tests.entries()].map(([, t]) => {
    const failures = t.history.filter(Boolean).length;
    let flips = 0;
    for (let i = 1; i < t.history.length; i++) if (t.history[i] !== t.history[i - 1]) flips++;
    const newestFailing = t.history[0];
    const consecutiveFromNewest = t.history.findIndex((x) => !x);
    const allFailing = failures === t.history.length;
    let classification: string;
    if (allFailing) classification = "consistently-failing";
    else if (flips <= 1 && newestFailing) classification = "recent-regression";
    else if (flips <= 1 && !newestFailing) classification = "fixed";
    else classification = "flaky";
    return {
      test: t.sample.automatedTestName ?? t.sample.testCaseTitle ?? String(t.sample.id),
      classification,
      failures,
      of: t.history.length,
      failRate: Math.round((failures / t.history.length) * 1000) / 1000,
      flips,
      failingStreakFromNewest: newestFailing ? (consecutiveFromNewest === -1 ? t.history.length : consecutiveFromNewest) : 0,
      history: t.history.map((x) => (x ? "F" : ".")).join(""),
      lastError: truncateText(t.sample.errorMessage?.split(/\r?\n/)[0], 300),
    };
  });

  const order: Record<string, number> = { flaky: 0, "recent-regression": 1, "consistently-failing": 2, fixed: 3 };
  const min = opts.minFailures ?? 1;
  return {
    runsWithTests: withTests.length,
    buildIds: withTests.map((b) => b.buildId),
    historyLegend: "newest first; F=failed .=passed or not run",
    tests: rows
      .filter((r) => r.failures >= min)
      .sort((a, b) => order[a.classification] - order[b.classification] || b.flips - a.flips || b.failures - a.failures)
      .slice(0, opts.top ?? 20),
  };
}

export async function findFlakyTests(client: AdoClient, definitionId: number, opts: FlakyOptions = {}) {
  const builds = await listBuilds(client, {
    definitionId,
    branch: opts.branch,
    status: "completed",
    result: "succeeded,partiallySucceeded,failed",
    top: opts.runs ?? 20,
  });
  const perBuild = await mapLimit(builds, 4, async (b): Promise<BuildTestFailures> => {
    const { keys, hasTests } = await failedTestKeys(client, b.id).catch(() => ({ keys: new Map(), hasTests: false }));
    return { buildId: b.id, hasTests, failed: keys };
  });
  return { pipelineId: definitionId, branch: opts.branch, ...scoreFlaky(perBuild, opts) };
}
