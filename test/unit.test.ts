import { describe, expect, it } from "vitest";
import { parsePipelineRef, parseRunRef } from "../src/refs.js";
import { normalizeOrg, resolveConfig } from "../src/config.js";
import { AdoClient } from "../src/client.js";
import { AdoError } from "../src/errors.js";
import { extractErrors, scoreLine } from "../src/analysis/errorExtract.js";
import { buildTree, findFailedSteps, latestAttempts } from "../src/analysis/timelineTree.js";
import { computeTrends } from "../src/analysis/trends.js";
import { scoreFlaky } from "../src/analysis/flaky.js";
import { fitBudget } from "../src/output.js";
import { grepLines } from "../src/commands/logs.js";
import { cleanLine } from "../src/api/logs.js";
import { errorSignature } from "../src/util.js";
import { mockFetch, testConfig } from "./helpers.js";
import { build, failedTimeline, testLog } from "./fixtures/scenario.js";

describe("refs", () => {
  it("parses ids and dev.azure.com URLs", () => {
    expect(parseRunRef("123")).toEqual({ buildId: 123 });
    expect(parseRunRef("https://dev.azure.com/acme/Web%20App/_build/results?buildId=42&view=logs&j=abc")).toEqual({
      buildId: 42,
      org: "https://dev.azure.com/acme",
      project: "Web App",
    });
  });
  it("parses visualstudio.com and on-prem URLs", () => {
    expect(parseRunRef("https://acme.visualstudio.com/Proj/_build/results?buildId=9")).toMatchObject({ org: "https://acme.visualstudio.com", project: "Proj" });
    expect(parseRunRef("https://tfs.corp/tfs/DefaultCollection/Proj/_build/results?buildId=9")).toMatchObject({
      org: "https://tfs.corp/tfs/DefaultCollection",
      project: "Proj",
    });
  });
  it("rejects junk", () => {
    expect(() => parseRunRef("abc")).toThrow(AdoError);
    expect(() => parseRunRef("https://dev.azure.com/acme/p/_build/results")).toThrow(/buildId/);
  });
  it("parses pipeline refs", () => {
    expect(parsePipelineRef("7")).toEqual({ id: 7 });
    expect(parsePipelineRef("https://dev.azure.com/a/p/_build?definitionId=12")).toEqual({ id: 12 });
    expect(parsePipelineRef("web-ci")).toEqual({ name: "web-ci" });
  });
});

describe("config", () => {
  it("normalises org names and reports all missing values", () => {
    expect(normalizeOrg("acme")).toBe("https://dev.azure.com/acme");
    expect(normalizeOrg("https://dev.azure.com/acme/")).toBe("https://dev.azure.com/acme");
    expect(() => resolveConfig({}, {})).toThrow(/AZURE_DEVOPS_PAT.*AZURE_DEVOPS_ORG.*AZURE_DEVOPS_PROJECT/);
  });
});

describe("client", () => {
  const noSleep = async () => {};
  it("sends basic auth, api-version, and follows continuation tokens", async () => {
    const seen: RequestInit[] = [];
    const mf = mockFetch([
      {
        match: /_apis\/build\/builds/,
        sequence: [
          { json: { value: [1, 2] }, headers: { "x-ms-continuationtoken": "tok" } },
          { json: { value: [3] } },
        ],
      },
    ]);
    const wrapped = (async (u: any, init: any) => (seen.push(init), mf.fetch(u, init))) as typeof fetch;
    const c = new AdoClient(testConfig, { fetch: wrapped, sleep: noSleep });
    expect(await c.list("_apis/build/builds")).toEqual([1, 2, 3]);
    expect(mf.calls[0]).toContain("/acme/Web App/_apis/build/builds?api-version=7.1");
    expect(mf.calls[1]).toContain("continuationToken=tok");
    expect((seen[0].headers as any).Authorization).toBe("Basic " + Buffer.from(":secret").toString("base64"));
  });
  it("retries 429 and 5xx", async () => {
    const mf = mockFetch([{ match: /x/, sequence: [{ status: 429, headers: { "retry-after": "1" } }, { status: 503 }, { json: { ok: 1 } }] }]);
    const c = new AdoClient(testConfig, { fetch: mf.fetch, sleep: noSleep });
    expect((await c.getJson("x")).data).toEqual({ ok: 1 });
    expect(mf.calls).toHaveLength(3);
  });
  it("maps auth failures, sign-in redirects and 404s", async () => {
    for (const status of [401, 203, 302]) {
      const c = new AdoClient(testConfig, { fetch: mockFetch([{ match: /x/, status }]).fetch, sleep: noSleep });
      await expect(c.getJson("x")).rejects.toMatchObject({ code: "AUTH" });
    }
    const c = new AdoClient(testConfig, { fetch: mockFetch([{ match: /x/, status: 404, json: { message: "Build 5 not found" } }]).fetch });
    await expect(c.getJson("x")).rejects.toMatchObject({ code: "NOT_FOUND", message: "Build 5 not found" });
  });
});

describe("errorExtract", () => {
  const lines = testLog.split("\n").map((l) => cleanLine(l));
  it("strips timestamps", () => {
    expect(lines[0]).toBe("##[section]Starting: Run unit tests");
  });
  it("finds the real failure and ranks it above the generic exit-code line", () => {
    const { snippets } = extractErrors(lines, { context: 2, maxSnippets: 1 });
    expect(snippets).toHaveLength(1);
    expect(snippets[0].lines.join("\n")).toContain("AssertionError: expected 3 to be 2");
  });
  it("keeps the final summary window when there is room", () => {
    const { snippets } = extractErrors(lines, { context: 1, maxSnippets: 3 });
    expect(snippets.map((s) => s.lines.join("\n")).join("\n")).toContain("1 failed | 70 passed");
    // line numbers are 1-based and correct
    const s = snippets[0];
    expect(lines[s.matchLines[0] - 1]).toMatch(/FAIL|AssertionError/);
  });
  it("ignores noise", () => {
    expect(scoreLine("Build succeeded. 0 errors, 0 warnings")).toBe(0);
    expect(scoreLine("$ErrorActionPreference = 'Stop'")).toBe(0);
    expect(scoreLine("src/foo.ts(3,5): error TS2304: Cannot find name 'x'.")).toBeGreaterThanOrEqual(9);
    expect(scoreLine("npm ERR! code ELIFECYCLE")).toBeGreaterThanOrEqual(8);
  });
});

describe("timelineTree", () => {
  const recs = failedTimeline.records as any[];
  it("builds a stage>job>task tree without phases or checkpoints", () => {
    const tree = buildTree(recs);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Build");
    expect(tree[0].children!.map((c) => c.name)).toEqual(["Linux"]);
    expect(tree[0].children![0].children!.map((c) => c.name)).toEqual(["npm ci", "Run unit tests", "Publish results"]);
  });
  it("failed-only keeps only failing branches", () => {
    const tree = buildTree(recs, { failedOnly: true });
    expect(tree[0].children![0].children!.map((c) => c.name)).toEqual(["Run unit tests"]);
  });
  it("finds the most specific failed step", () => {
    const failed = findFailedSteps(recs);
    expect(failed.map((f) => f.path)).toEqual(["Build > Linux > Run unit tests"]);
    expect(failed[0].logId).toBe(4);
  });
  it("reports a failed job with no failed task (e.g. agent lost)", () => {
    const failed = findFailedSteps([
      { id: "j", type: "Job", name: "Win", result: "failed", issues: [{ type: "error", message: "The agent lost communication" }] },
      { id: "t", parentId: "j", type: "Task", name: "build", result: "canceled" },
    ] as any);
    expect(failed.map((f) => f.path)).toEqual(["Win"]);
  });
  it("keeps only the latest attempt of a retried job", () => {
    const kept = latestAttempts([
      { id: "a", type: "Job", identifier: "J", name: "J", attempt: 1, result: "failed" },
      { id: "a1", parentId: "a", type: "Task", name: "t", result: "failed" },
      { id: "b", type: "Job", identifier: "J", name: "J", attempt: 2, result: "succeeded" },
    ] as any);
    expect(kept.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("trends", () => {
  it("computes pass rate, streak and where it broke", () => {
    // newest first: F F S S F S
    const builds = [
      build(106, "failed"),
      build(105, "failed"),
      build(104, "succeeded"),
      build(103, "canceled"),
      build(102, "succeeded"),
      build(101, "failed"),
      build(100, "succeeded"),
    ] as any;
    const t = computeTrends(builds);
    expect(t.history).toBe("FFSCSFS");
    expect(t.passRate).toBe(0.5);
    expect(t.currentStreak).toEqual({ result: "failed", length: 2 });
    expect(t.lastSuccess?.id).toBe(104);
    expect(t.brokeAt?.id).toBe(105);
    expect(t.durations.succeeded?.count).toBe(3);
  });
});

describe("flaky", () => {
  const r = (name: string) => [name.toLowerCase(), { id: 1, automatedTestName: name, errorMessage: "boom\nmore" }] as [string, any];
  it("classifies flaky, regression, consistent and fixed tests", () => {
    // newest first
    const builds = [
      { buildId: 6, hasTests: true, failed: new Map([r("Flaky"), r("Regressed"), r("Always")]) },
      { buildId: 5, hasTests: true, failed: new Map([r("Regressed"), r("Always")]) },
      { buildId: 4, hasTests: true, failed: new Map([r("Flaky"), r("Always")]) },
      { buildId: 3, hasTests: false, failed: new Map() },
      { buildId: 2, hasTests: true, failed: new Map([r("Always"), r("Fixed")]) },
      { buildId: 1, hasTests: true, failed: new Map([r("Flaky"), r("Always"), r("Fixed")]) },
    ];
    const res = scoreFlaky(builds);
    expect(res.runsWithTests).toBe(5);
    const by = Object.fromEntries(res.tests.map((t) => [t.test, t]));
    expect(by.Flaky).toMatchObject({ classification: "flaky", failures: 3, history: "F.F.F" });
    expect(by.Regressed).toMatchObject({ classification: "recent-regression", failingStreakFromNewest: 2 });
    expect(by.Always.classification).toBe("consistently-failing");
    expect(by.Fixed.classification).toBe("fixed");
    expect(by.Flaky.lastError).toBe("boom");
    expect(res.tests[0].test).toBe("Flaky");
  });
});

describe("output budget", () => {
  it("leaves small output alone and shrinks large output explicitly", () => {
    const small = { a: 1 };
    expect(fitBudget(small, 1000, (v) => JSON.stringify(v))).toEqual({ text: '{"a":1}', truncated: false });
    const big = { lines: Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(50)}`) };
    const { text, truncated } = fitBudget(big, 5000, (v) => JSON.stringify(v));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(5000);
    const parsed = JSON.parse(text);
    expect(parsed._truncated.maxChars).toBe(5000);
    expect(parsed.lines.at(-1)).toMatch(/more items/);
  });
});

describe("grep", () => {
  it("merges overlapping context blocks with correct line numbers", () => {
    const lines = ["a", "err 1", "b", "err 2", "c", "d", "e", "f", "err 3"];
    const { blocks, matches } = grepLines(lines, /err/i, 1, 10);
    expect(matches).toBe(3);
    expect(blocks).toEqual([
      { startLine: 10, lines: ["a", "err 1", "b", "err 2", "c"] },
      { startLine: 17, lines: ["f", "err 3"] },
    ]);
  });
});

describe("errorSignature", () => {
  it("matches the same error across runs despite ids, paths and numbers", () => {
    expect(errorSignature("Failed at /home/vsts/work/1/s/src/a.ts:12 build 4411")).toBe(
      errorSignature("Failed at /home/vsts/work/7/s/src/a.ts:99 build 4500"),
    );
  });
});
