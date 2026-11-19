import type { AdoClient } from "../client.js";
import { compactBuild, listBuilds, type RawBuild } from "../api/builds.js";
import { getTimeline } from "../api/timeline.js";
import { findFailedSteps } from "./timelineTree.js";
import { mapLimit, percentile } from "../util.js";

export interface TrendOptions {
  top?: number;
  branch?: string;
  failureBreakdown?: number; // how many failed runs to inspect for recurring failing steps (0 disables)
}

const LETTER: Record<string, string> = { succeeded: "S", partiallySucceeded: "P", failed: "F", canceled: "C" };

export function computeTrends(builds: RawBuild[]) {
  // builds are newest first
  const completed = builds.filter((b) => b.status === "completed");
  const counts: Record<string, number> = {};
  for (const b of completed) counts[b.result ?? "none"] = (counts[b.result ?? "none"] ?? 0) + 1;
  const decided = completed.filter((b) => b.result !== "canceled");
  const passRate = decided.length ? round((counts.succeeded ?? 0) / decided.length, 3) : undefined;

  const durations = (filter: (b: RawBuild) => boolean) => {
    const d = completed
      .filter(filter)
      .map((b) => compactBuild(b).durationSec)
      .filter((x): x is number => x !== undefined)
      .sort((a, b) => a - b);
    return d.length
      ? { count: d.length, p50Sec: percentile(d, 50), p90Sec: percentile(d, 90), maxSec: d[d.length - 1], minSec: d[0] }
      : undefined;
  };

  // Current streak (ignoring cancelled runs).
  let streak: { result: string; length: number } | undefined;
  for (const b of decided) {
    if (!streak) streak = { result: b.result!, length: 1 };
    else if (b.result === streak.result) streak.length++;
    else break;
  }

  const lastSuccessIdx = decided.findIndex((b) => b.result === "succeeded");
  const lastSuccess = lastSuccessIdx >= 0 ? decided[lastSuccessIdx] : undefined;
  // If currently broken, the oldest run in the current non-success streak is where it broke.
  let brokeAt: RawBuild | undefined;
  if (decided.length && decided[0].result !== "succeeded") {
    brokeAt = lastSuccessIdx === -1 ? decided[decided.length - 1] : decided[lastSuccessIdx - 1];
  }

  // Half-over-half comparison, to show whether things are getting better or worse.
  const half = Math.floor(decided.length / 2);
  const rate = (xs: RawBuild[]) => (xs.length ? round(xs.filter((b) => b.result === "succeeded").length / xs.length, 3) : undefined);
  const recentRate = half ? rate(decided.slice(0, half)) : undefined;
  const olderRate = half ? rate(decided.slice(half)) : undefined;

  const pick = (b?: RawBuild) => {
    if (!b) return undefined;
    const c = compactBuild(b);
    return { id: c.id, number: c.number, result: c.result, commit: c.commit, requestedFor: c.requestedFor, finishedAt: c.finishedAt };
  };

  return {
    window: {
      runs: builds.length,
      completed: completed.length,
      from: completed[completed.length - 1]?.finishTime,
      to: completed[0]?.finishTime,
    },
    counts,
    passRate,
    passRateTrend: recentRate !== undefined && olderRate !== undefined ? { recentHalf: recentRate, olderHalf: olderRate } : undefined,
    durations: { succeeded: durations((b) => b.result === "succeeded"), all: durations(() => true) },
    history: completed.map((b) => LETTER[b.result ?? ""] ?? "?").join(""),
    historyLegend: "newest first; S=succeeded P=partiallySucceeded F=failed C=canceled",
    currentStreak: streak,
    lastSuccess: pick(lastSuccess),
    brokeAt: pick(brokeAt),
    inProgress: builds.filter((b) => b.status !== "completed").map((b) => ({ id: b.id, status: b.status })),
  };
}

export async function pipelineTrends(client: AdoClient, definitionId: number, opts: TrendOptions = {}) {
  const builds = await listBuilds(client, { definitionId, branch: opts.branch, top: opts.top ?? 50 });
  const stats = computeTrends(builds);

  let recurringFailures: { step: string; count: number; runs: number[] }[] | undefined;
  const n = opts.failureBreakdown ?? 10;
  if (n > 0) {
    const failedRuns = builds.filter((b) => b.result === "failed" || b.result === "partiallySucceeded").slice(0, n);
    const steps = await mapLimit(failedRuns, 4, async (b) => ({
      id: b.id,
      steps: findFailedSteps(await getTimeline(client, b.id).catch(() => [])).map((s) => s.path),
    }));
    const tally = new Map<string, number[]>();
    for (const { id, steps: paths } of steps) for (const p of new Set(paths)) tally.set(p, [...(tally.get(p) ?? []), id]);
    recurringFailures = [...tally.entries()]
      .map(([step, runs]) => ({ step, count: runs.length, runs }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }

  return { pipelineId: definitionId, branch: opts.branch, ...stats, recurringFailures, inspectedFailedRuns: recurringFailures ? Math.min(n, builds.filter((b) => b.result === "failed" || b.result === "partiallySucceeded").length) : undefined };
}

function round(x: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
