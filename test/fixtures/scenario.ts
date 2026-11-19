// A small, realistic failed run: build 120 on main fails in "Run unit tests"; 118 was the last success.

export const definition = { id: 7, name: "web-ci", path: "\\" };

export function build(id: number, result: string, extra: Record<string, unknown> = {}) {
  // Each build is queued 10 minutes after the previous id and runs 4-8 minutes.
  const queued = Date.parse("2026-11-18T00:00:00Z") + id * 10 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id,
    buildNumber: `20261118.${id}`,
    status: "completed",
    result,
    queueTime: iso(queued),
    startTime: iso(queued + 10_000),
    finishTime: iso(queued + 10_000 + (4 + (id % 5)) * 60_000),
    sourceBranch: "refs/heads/main",
    sourceVersion: `abc${id}def`,
    reason: "individualCI",
    definition,
    requestedFor: { displayName: "Dev One" },
    repository: { name: "web" },
    uri: `vstfs:///Build/Build/${id}`,
    _links: { web: { href: `https://dev.azure.com/acme/Web%20App/_build/results?buildId=${id}` } },
    ...extra,
  };
}

export const failedTimeline = {
  records: [
    { id: "s1", parentId: null, type: "Stage", name: "Build", identifier: "Build", result: "failed", state: "completed", order: 1, startTime: "2026-11-18T10:00:10Z", finishTime: "2026-11-18T10:05:10Z" },
    { id: "p1", parentId: "s1", type: "Phase", name: "Build", identifier: "Build.__default", result: "failed", state: "completed", order: 1 },
    { id: "j1", parentId: "p1", type: "Job", name: "Linux", identifier: "Build.Linux", result: "failed", state: "completed", order: 1, workerName: "Hosted Agent", startTime: "2026-11-18T10:00:20Z", finishTime: "2026-11-18T10:05:00Z", log: { id: 2 } },
    { id: "t1", parentId: "j1", type: "Task", name: "npm ci", result: "succeeded", state: "completed", order: 1, startTime: "2026-11-18T10:00:30Z", finishTime: "2026-11-18T10:01:30Z", log: { id: 3 } },
    {
      id: "t2", parentId: "j1", type: "Task", name: "Run unit tests", result: "failed", state: "completed", order: 2, errorCount: 2,
      startTime: "2026-11-18T10:01:31Z", finishTime: "2026-11-18T10:04:30Z", log: { id: 4 },
      issues: [
        { type: "error", message: "src/cart.test.ts: expected 3 but received 2" },
        { type: "error", message: "Process completed with exit code 1." },
      ],
    },
    { id: "t3", parentId: "j1", type: "Task", name: "Publish results", result: "skipped", state: "completed", order: 3 },
    { id: "c1", parentId: "s1", type: "Checkpoint", name: "Checkpoint", result: "succeeded", state: "completed", order: 0 },
  ],
};

export const goodTimeline = {
  records: [
    { id: "s1", parentId: null, type: "Stage", name: "Build", identifier: "Build", result: "succeeded", state: "completed", order: 1, startTime: "2026-11-18T09:00:10Z", finishTime: "2026-11-18T09:02:10Z" },
    { id: "p1", parentId: "s1", type: "Phase", name: "Build", identifier: "Build.__default", result: "succeeded", state: "completed", order: 1 },
    { id: "j1", parentId: "p1", type: "Job", name: "Linux", identifier: "Build.Linux", result: "succeeded", state: "completed", order: 1, startTime: "2026-11-18T09:00:20Z", finishTime: "2026-11-18T09:02:00Z", log: { id: 2 } },
    { id: "t2", parentId: "j1", type: "Task", name: "Run unit tests", result: "succeeded", state: "completed", order: 2, log: { id: 4 } },
  ],
};

export const testLog = [
  "2026-11-18T10:01:31.0000000Z ##[section]Starting: Run unit tests",
  "2026-11-18T10:01:32.0000000Z > web@1.0.0 test",
  "2026-11-18T10:01:33.0000000Z > vitest run",
  ...Array.from({ length: 40 }, (_, i) => `2026-11-18T10:02:${String(i).padStart(2, "0")}.0000000Z  ✓ src/module${i}.test.ts (3 tests)`),
  "2026-11-18T10:03:00.0000000Z  FAIL  src/cart.test.ts > cart > totals items",
  "2026-11-18T10:03:00.1000000Z AssertionError: expected 3 to be 2",
  "2026-11-18T10:03:00.2000000Z     at src/cart.test.ts:14:22",
  ...Array.from({ length: 30 }, (_, i) => `2026-11-18T10:03:${String(i + 10).padStart(2, "0")}.0000000Z  ✓ src/other${i}.test.ts (1 test)`),
  "2026-11-18T10:04:00.0000000Z  Test Files  1 failed | 70 passed (71)",
  "2026-11-18T10:04:29.0000000Z ##[error]Process completed with exit code 1.",
  "2026-11-18T10:04:30.0000000Z ##[section]Finishing: Run unit tests",
].join("\n");

export const testRuns = {
  value: [
    { id: 900, name: "Unit tests", state: "Completed", totalTests: 71, passedTests: 70, runStatistics: [{ outcome: "Passed", count: 70 }, { outcome: "Failed", count: 1 }] },
  ],
};

export const failedResults = {
  value: [
    {
      id: 1,
      testCaseTitle: "cart totals items",
      automatedTestName: "src/cart.test.ts > cart > totals items",
      outcome: "Failed",
      errorMessage: "AssertionError: expected 3 to be 2",
      stackTrace: "at src/cart.test.ts:14:22\nat runTest (node_modules/vitest/dist/runner.js:10:3)",
      durationInMs: 12.4,
    },
  ],
};

export const changes = {
  value: [
    { id: "abc120def", message: "Change cart rounding\n\nlong body", author: { displayName: "Dev Two" }, timestamp: "2026-11-18T09:50:00Z" },
    { id: "abc119def", message: "Bump deps", author: { displayName: "Dev One" }, timestamp: "2026-11-18T09:40:00Z" },
  ],
};

import type { Route } from "../helpers.js";

export function scenarioRoutes(): Route[] {
  return [
    { match: /_apis\/build\/builds\/120\/timeline/, json: failedTimeline },
    { match: /_apis\/build\/builds\/118\/timeline/, json: goodTimeline },
    { match: /_apis\/build\/builds\/120\/logs\/4/, text: testLog },
    { match: /_apis\/build\/builds\/120\/logs\?/, json: { value: [{ id: 2, lineCount: 500 }, { id: 3, lineCount: 50 }, { id: 4, lineCount: 77 }] } },
    { match: /_apis\/build\/builds\/120\?/, json: build(120, "failed") },
    { match: /_apis\/build\/builds\/118\?/, json: build(118, "succeeded") },
    { match: /_apis\/build\/builds\?.*resultFilter=succeeded/, json: { value: [build(118, "succeeded"), build(110, "succeeded")] } },
    { match: /_apis\/build\/changes\?.*fromBuildId=118.*toBuildId=120/, json: changes },
    { match: /_apis\/test\/runs\?.*Build%2F120|_apis\/test\/runs\?.*Build\/120/, json: testRuns },
    { match: /_apis\/test\/runs\?.*Build%2F118|_apis\/test\/runs\?.*Build\/118/, json: { value: [{ id: 800, name: "Unit tests", totalTests: 71, passedTests: 71, runStatistics: [{ outcome: "Passed", count: 71 }] }] } },
    { match: /_apis\/test\/Runs\/900\/results/, json: failedResults },
  ];
}
