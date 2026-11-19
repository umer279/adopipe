import { describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";
import { build, definition, scenarioRoutes } from "./fixtures/scenario.js";

const URL120 = "https://dev.azure.com/acme/Web%20App/_build/results?buildId=120&view=results";

describe("cli end-to-end (mocked Azure DevOps)", () => {
  it("analyze: summary, failures with snippets, failed tests, diff vs last good", async () => {
    // No org/project in env: they must come from the URL.
    const { code, stdout, stderr } = await runCli(["analyze", URL120], scenarioRoutes(), { AZURE_DEVOPS_PAT: "secret" });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const out = JSON.parse(stdout);

    expect(out.run).toMatchObject({ id: 120, result: "failed", branch: "main", pipeline: { id: 7, name: "web-ci" } });

    expect(out.failures.failedCount).toBe(1);
    const f = out.failures.failures[0];
    expect(f.path).toBe("Build > Linux > Run unit tests");
    expect(f.issues[0].message).toContain("expected 3 but received 2");
    expect(f.snippets.flatMap((s: any) => s.lines).join("\n")).toContain("AssertionError: expected 3 to be 2");

    expect(out.tests.totals).toMatchObject({ total: 71, passed: 70, failed: 1 });
    expect(out.tests.results[0]).toMatchObject({ name: "cart totals items", errorMessage: "AssertionError: expected 3 to be 2" });

    const d = out.diffVsLastGood;
    expect(d.base.id).toBe(118);
    expect(d.commits.items.map((c: any) => c.message)).toEqual(["Change cart rounding", "Bump deps"]);
    expect(d.errors.new.join("\n")).toContain("expected 3 but received 2");
    expect(d.jobs.resultChanges).toContainEqual({ job: "Job: Build > Linux", base: "succeeded", run: "failed" });
    expect(d.tests.newFailures).toEqual(["src/cart.test.ts > cart > totals items"]);

    expect(out.nextSteps[0]).toBe('adopipe run logs 120 --log 4 --grep "error|fail" --context 20');
  });

  it("run logs --task --grep returns matching blocks", async () => {
    const { code, stdout } = await runCli(["run", "logs", "120", "--task", "unit", "--grep", "assertion", "--context", "1"], scenarioRoutes());
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.logs[0]).toMatchObject({ logId: 4, step: "Build > Linux > Run unit tests", matches: 1 });
    expect(out.logs[0].blocks[0].lines).toHaveLength(3);
  });

  it("run timeline --failed-only", async () => {
    const { stdout } = await runCli(["run", "timeline", "120", "--failed-only"], scenarioRoutes());
    const out = JSON.parse(stdout);
    expect(out.timeline[0].children[0].children.map((t: any) => t.name)).toEqual(["Run unit tests"]);
  });

  it("runs list resolves a pipeline by name", async () => {
    const routes = [
      { match: /_apis\/build\/definitions/, json: { value: [definition, { id: 8, name: "web-ci-nightly" }] } },
      { match: /_apis\/build\/builds\?.*definitions=7/, json: { value: [build(120, "failed"), build(118, "succeeded")] } },
    ];
    const { code, stdout } = await runCli(["runs", "list", "--pipeline", "web-ci", "--top", "2"], routes);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).runs.map((r: any) => r.id)).toEqual([120, 118]);
  });

  it("reports auth errors as JSON with exit code 2", async () => {
    const { code, stdout, stderr } = await runCli(["run", "show", "120"], [{ match: /.*/, status: 401 }]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.code).toBe("AUTH");
  });

  it("reports missing config and usage errors with exit code 1", async () => {
    const missing = await runCli(["run", "show", "120"], [], {});
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).error.message).toMatch(/AZURE_DEVOPS_PAT/);
    const usage = await runCli(["run", "show"], []);
    expect(usage.code).toBe(1);
    expect(JSON.parse(usage.stderr).error.code).toBe("USAGE");
  });

  it("not found is exit code 3", async () => {
    const { code } = await runCli(["run", "show", "999"], [{ match: /builds\/999/, status: 404, json: { message: "Build 999 not found" } }]);
    expect(code).toBe(3);
  });

  it("respects --max-chars", async () => {
    const { stdout } = await runCli(["--max-chars", "1500", "analyze", "120"], scenarioRoutes());
    expect(stdout.length).toBeLessThanOrEqual(1500);
    expect(JSON.parse(stdout)._truncated).toBeDefined();
  });
});
