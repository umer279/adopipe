import type { AdoClient } from "../client.js";
import { compactBuild, getBuild, listBuilds, shortBranch, type RawBuild } from "../api/builds.js";
import { compactChange, getChangesBetween } from "../api/changes.js";
import { getTimeline, type TimelineRecord } from "../api/timeline.js";
import { AdoError } from "../errors.js";
import { analyzeFailures, type FailureReport } from "./failures.js";
import { failedTestKeys } from "./testsSummary.js";
import { jobSummary } from "./timelineTree.js";
import { errorSignature as sigOf } from "../util.js";

/** Most recent succeeded build of the same pipeline and branch that was queued before `build`. */
export async function findLastGood(client: AdoClient, build: RawBuild): Promise<RawBuild | undefined> {
  if (!build.definition) return undefined;
  const candidates = await listBuilds(client, {
    definitionId: build.definition.id,
    branch: build.sourceBranch,
    result: "succeeded",
    status: "completed",
    top: 50,
  });
  const queued = build.queueTime ? Date.parse(build.queueTime) : Infinity;
  return candidates.find((b) => b.id !== build.id && (b.queueTime ? Date.parse(b.queueTime) < queued : b.id < build.id));
}

export interface DiffOptions {
  against?: string; // build id, or "last-good" (default)
  maxCommits?: number;
  includeTests?: boolean;
  durationThresholdSec?: number;
  failureReport?: FailureReport; // reuse if already computed
  records?: TimelineRecord[];
}

export async function diffRuns(client: AdoClient, build: RawBuild, opts: DiffOptions = {}) {
  const against = opts.against ?? "last-good";
  let base: RawBuild | undefined;
  if (against === "last-good") {
    base = await findLastGood(client, build);
    if (!base) {
      return {
        run: brief(build),
        base: null,
        note: `No earlier succeeded run found for this pipeline on branch ${shortBranch(build.sourceBranch)} (looked at the last 50).`,
      };
    }
  } else if (/^\d+$/.test(against)) {
    base = await getBuild(client, Number(against));
  } else {
    throw new AdoError("USAGE", `--against must be a build id or "last-good", got "${against}"`);
  }

  const [runRecords, baseRecords] = await Promise.all([
    opts.records ?? getTimeline(client, build.id),
    getTimeline(client, base.id),
  ]);

  const sameDefinition = build.definition?.id === base.definition?.id;
  const [changes, runFailures, baseFailures, runTests, baseTests] = await Promise.all([
    sameDefinition
      ? getChangesBetween(client, Math.min(base.id, build.id), Math.max(base.id, build.id), opts.maxCommits ?? 50).catch(() => undefined)
      : Promise.resolve(undefined),
    opts.failureReport ?? analyzeFailures(client, build, { includeLogs: false }, runRecords),
    analyzeFailures(client, base, { includeLogs: false }, baseRecords),
    opts.includeTests === false ? undefined : failedTestKeys(client, build.id).catch(() => undefined),
    opts.includeTests === false ? undefined : failedTestKeys(client, base.id).catch(() => undefined),
  ]);

  // Errors: compare normalised signatures.
  const baseSigs = new Set(baseFailures.signatures);
  const runSigs = new Set(runFailures.signatures);
  const sigToMessage = new Map<string, string>();
  for (const f of runFailures.failures) {
    for (const i of f.issues ?? []) if (i.type === "error") sigToMessage.set(sigOf(i.message), `${f.path}: ${i.message}`);
  }
  const describe = (s: string) => sigToMessage.get(s) ?? s;

  // Jobs: result changes and big duration changes.
  const runJobs = jobSummary(runRecords);
  const baseJobs = jobSummary(baseRecords);
  const threshold = opts.durationThresholdSec ?? 60;
  const resultChanges: { job: string; base?: string; run?: string }[] = [];
  const durationChanges: { job: string; baseSec?: number; runSec?: number; deltaSec: number }[] = [];
  for (const [job, r] of runJobs) {
    const b = baseJobs.get(job);
    if (!b) {
      resultChanges.push({ job, base: "(absent)", run: r.result });
      continue;
    }
    if (b.result !== r.result) resultChanges.push({ job, base: b.result, run: r.result });
    if (r.durationSec !== undefined && b.durationSec !== undefined) {
      const delta = r.durationSec - b.durationSec;
      if (Math.abs(delta) >= threshold && Math.abs(delta) >= 0.5 * Math.max(1, b.durationSec)) {
        durationChanges.push({ job, baseSec: b.durationSec, runSec: r.durationSec, deltaSec: delta });
      }
    }
  }
  for (const [job, b] of baseJobs) if (!runJobs.has(job)) resultChanges.push({ job, base: b.result, run: "(absent)" });
  durationChanges.sort((a, b) => Math.abs(b.deltaSec) - Math.abs(a.deltaSec));

  let tests: Record<string, unknown> | undefined;
  if (runTests && baseTests) {
    const newFailures = [...runTests.keys.keys()].filter((k) => !baseTests.keys.has(k));
    const stillFailing = [...runTests.keys.keys()].filter((k) => baseTests.keys.has(k));
    const fixed = [...baseTests.keys.keys()].filter((k) => !runTests.keys.has(k));
    const name = (m: Map<string, any>, k: string) => m.get(k)?.automatedTestName ?? m.get(k)?.testCaseTitle ?? k;
    tests = {
      newFailures: newFailures.slice(0, 50).map((k) => name(runTests.keys, k)),
      newFailureCount: newFailures.length,
      stillFailing: stillFailing.slice(0, 20).map((k) => name(runTests.keys, k)),
      stillFailingCount: stillFailing.length,
      fixed: fixed.slice(0, 20).map((k) => name(baseTests.keys, k)),
      fixedCount: fixed.length,
    };
  }

  const commits = changes?.map(compactChange);
  return {
    run: brief(build),
    base: brief(base),
    sameBranch: build.sourceBranch === base.sourceBranch,
    commits: commits ? { count: commits.length, items: commits } : { note: "Commit list unavailable (different pipelines or API error)." },
    errors: {
      new: [...runSigs].filter((s) => !baseSigs.has(s)).map(describe),
      persisting: [...runSigs].filter((s) => baseSigs.has(s)).map(describe),
      resolved: [...baseSigs].filter((s) => !runSigs.has(s)),
    },
    jobs: { resultChanges, durationChanges: durationChanges.slice(0, 15) },
    tests,
  };
}

function brief(b: RawBuild) {
  const c = compactBuild(b);
  return { id: c.id, number: c.number, result: c.result, branch: c.branch, commit: c.commit, finishedAt: c.finishedAt, durationSec: c.durationSec };
}

