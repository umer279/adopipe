import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { AdoClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { loadEnvFiles } from "./envFile.js";
import { AdoError, EXIT_CODES } from "./errors.js";
import { formatOutput, type Format } from "./output.js";
import { parsePipelineRef, parseRunRef } from "./refs.js";
import { compactBuild, getBuild, listBuilds } from "./api/builds.js";
import { compactDefinition, listDefinitions, resolvePipeline } from "./api/definitions.js";
import { getTimeline } from "./api/timeline.js";
import { buildTree } from "./analysis/timelineTree.js";
import { analyzeFailures } from "./analysis/failures.js";
import { getTestSummary } from "./analysis/testsSummary.js";
import { diffRuns } from "./analysis/diff.js";
import { pipelineTrends } from "./analysis/trends.js";
import { findFlakyTests } from "./analysis/flaky.js";
import { runLogs } from "./commands/logs.js";
import { compactArtifact, downloadArtifact, listArtifacts } from "./api/artifacts.js";

export const VERSION = "0.1.0";

export interface Deps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTTY?: boolean;
}

interface GlobalOpts {
  org?: string;
  project?: string;
  format: Format;
  pretty?: boolean;
  maxChars: number;
}

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
  return n;
};

export function buildProgram(deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s + "\n"));
  const isTTY = deps.isTTY ?? !!process.stdout.isTTY;

  const program = new Command();
  program
    .name("adopipe")
    .description(
      "Read and analyze Azure DevOps pipeline runs. Output is JSON for AI agents.\n" +
        "Auth: AZURE_DEVOPS_PAT. Org/project: AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, the flags below, or a full build URL.\n" +
        "Unset variables are also read from ./.env, then ~/.adopipe.env.\n" +
        "Start with: adopipe analyze <buildId|buildUrl>",
    )
    .version(VERSION)
    .option("--org <org>", "organization name or URL (env AZURE_DEVOPS_ORG)")
    .option("--project <project>", "project name (env AZURE_DEVOPS_PROJECT)")
    .addOption(new Option("--format <format>", "output format").choices(["json", "text"]).default("json"))
    .option("--pretty", "indent JSON (the default when stdout is a terminal)")
    .option("--max-chars <n>", "output size budget; long fields are truncated explicitly (0 = unlimited)", int("--max-chars"), 24000)
    .showHelpAfterError()
    .exitOverride();

  const globals = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts;

  const client = (cmd: Command, override?: { org?: string; project?: string }) => {
    const g = globals(cmd);
    const cfg = resolveConfig({ org: g.org ?? override?.org, project: g.project ?? override?.project }, env);
    return new AdoClient(cfg, { fetch: deps.fetch });
  };

  const emit = (cmd: Command, value: unknown) => {
    const g = globals(cmd);
    stdout(formatOutput(value, { format: g.format, pretty: g.pretty ?? isTTY, maxChars: g.maxChars }));
  };

  /** Resolve a run argument (id or URL) into a client + build. */
  const loadRun = async (cmd: Command, ref: string) => {
    const r = parseRunRef(ref);
    const c = client(cmd, { org: r.org, project: r.project });
    const build = await getBuild(c, r.buildId);
    return { c, build };
  };

  // ---- pipelines ---------------------------------------------------------
  const pipelines = program.command("pipelines").description("pipeline definitions");
  pipelines
    .command("list")
    .description("list pipelines with their latest run")
    .option("--filter <text>", "name contains (supports * wildcards)")
    .option("--top <n>", "max pipelines", int("--top"), 200)
    .action(async (opts, cmd) => {
      const defs = await listDefinitions(client(cmd), opts.filter, opts.top);
      emit(cmd, { count: defs.length, pipelines: defs.map(compactDefinition) });
    });

  // ---- runs --------------------------------------------------------------
  const runs = program.command("runs").description("lists of runs");
  runs
    .command("list")
    .description("recent runs, newest first")
    .option("--pipeline <idOrName>", "pipeline id or name (omit for all pipelines)")
    .option("--branch <branch>", "branch name, e.g. main or refs/pull/12/merge")
    .option("--result <results>", "comma list: succeeded,partiallySucceeded,failed,canceled")
    .option("--status <statuses>", "comma list: inProgress,completed,notStarted,cancelling")
    .option("--reason <reasons>", "comma list: manual,individualCI,batchedCI,schedule,pullRequest,...")
    .option("--top <n>", "max runs", int("--top"), 20)
    .action(async (opts, cmd) => {
      const c = client(cmd);
      const pipeline = opts.pipeline ? await resolvePipeline(c, parsePipelineRef(opts.pipeline)) : undefined;
      const builds = await listBuilds(c, {
        definitionId: pipeline?.id,
        branch: opts.branch,
        result: opts.result,
        status: opts.status,
        reason: opts.reason,
        top: opts.top,
      });
      emit(cmd, { count: builds.length, runs: builds.map(compactBuild) });
    });

  // ---- run <subcommand> --------------------------------------------------
  const run = program.command("run").description("inspect a single run (build id or build results URL)");

  run
    .command("show")
    .description("run metadata")
    .argument("<run>", "build id or build results URL")
    .action(async (ref, _opts, cmd) => {
      const { build } = await loadRun(cmd, ref);
      emit(cmd, compactBuild(build));
    });

  run
    .command("timeline")
    .description("stage > job > task tree with results, durations, log ids and issues")
    .argument("<run>", "build id or build results URL")
    .option("--failed-only", "only branches containing failures or errors")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      const records = await getTimeline(c, build.id);
      emit(cmd, { buildId: build.id, result: build.result, status: build.status, timeline: buildTree(records, { failedOnly: opts.failedOnly }) });
    });

  run
    .command("logs")
    .description("list logs, or read one by --log id or --task name, optionally filtered")
    .argument("<run>", "build id or build results URL")
    .option("--log <id>", "log id (from timeline or the log list)", int("--log"))
    .option("--task <name>", "step name contains (failed steps are preferred)")
    .option("--grep <regex>", "case-insensitive regex; returns matching blocks with context")
    .option("--context <n>", "lines of context around --grep matches", int("--context"), 3)
    .option("--head <n>", "first N lines", int("--head"))
    .option("--tail <n>", "last N lines (default 200 when no other filter)", int("--tail"))
    .option("--range <a-b>", "line range, e.g. 120-260")
    .option("--timestamps", "keep the per-line timestamps")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      emit(cmd, await runLogs(c, build.id, opts));
    });

  run
    .command("failures")
    .description("failed steps with their issues and the log snippets around errors")
    .argument("<run>", "build id or build results URL")
    .option("--context <n>", "lines of context around each error", int("--context"), 8)
    .option("--max-snippets <n>", "snippets per failed step", int("--max-snippets"), 4)
    .option("--max-failures <n>", "failed steps to report", int("--max-failures"), 10)
    .option("--no-logs", "only use timeline issues; do not download logs")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      const report = await analyzeFailures(c, build, {
        context: opts.context,
        maxSnippets: opts.maxSnippets,
        maxFailures: opts.maxFailures,
        includeLogs: opts.logs,
      });
      const { signatures: _s, ...rest } = report;
      emit(cmd, rest);
    });

  run
    .command("tests")
    .description("test run totals and failed tests with messages and stack traces")
    .argument("<run>", "build id or build results URL")
    .option("--outcome <outcomes>", 'comma list of outcomes, or "all"', "Failed,Aborted,Error,Timeout")
    .option("--top <n>", "max results", int("--top"), 50)
    .option("--stack-lines <n>", "stack trace lines per result", int("--stack-lines"), 12)
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      emit(cmd, await getTestSummary(c, build.id, { outcomes: opts.outcome, top: opts.top, maxStackLines: opts.stackLines }));
    });

  run
    .command("diff")
    .description("compare with the last good run (or another run): commits, new errors, job and test changes")
    .argument("<run>", "build id or build results URL")
    .option("--against <run>", 'build id, or "last-good"', "last-good")
    .option("--no-tests", "skip test comparison")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      const against = opts.against === "last-good" ? "last-good" : String(parseRunRef(opts.against).buildId);
      emit(cmd, await diffRuns(c, build, { against, includeTests: opts.tests }));
    });

  run
    .command("artifacts")
    .description("list the run's artifacts, or download one as a zip (optionally extracted)")
    .argument("<run>", "build id or build results URL")
    .option("--download <name>", "artifact name to download")
    .option("--out <dir>", "download folder (default ./adopipe-artifacts/<buildId>)")
    .option("--extract", "extract the zip into --out (keeps the zip)")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      if (!opts.download) {
        if (opts.out || opts.extract) throw new AdoError("USAGE", "--out and --extract need --download <name>");
        const artifacts = await listArtifacts(c, build.id);
        emit(cmd, { buildId: build.id, count: artifacts.length, artifacts: artifacts.map(compactArtifact) });
        return;
      }
      const out = opts.out ?? `adopipe-artifacts/${build.id}`;
      emit(cmd, await downloadArtifact(c, build.id, opts.download, out, { extract: opts.extract }));
    });

  // ---- pipeline <subcommand> --------------------------------------------
  const pipeline = program.command("pipeline").description("analysis across many runs of one pipeline");

  pipeline
    .command("trends")
    .description("pass rate, durations, streaks, where it broke, and recurring failing steps")
    .argument("<pipeline>", "pipeline id, name, or definition URL")
    .option("--top <n>", "runs to look at", int("--top"), 50)
    .option("--branch <branch>", "only this branch")
    .option("--breakdown <n>", "failed runs to inspect for recurring failing steps (0 = off)", int("--breakdown"), 10)
    .action(async (ref, opts, cmd) => {
      const c = client(cmd);
      const p = await resolvePipeline(c, parsePipelineRef(ref));
      const result = await pipelineTrends(c, p.id, { top: opts.top, branch: opts.branch, failureBreakdown: opts.breakdown });
      emit(cmd, { pipelineName: p.name, ...result });
    });

  pipeline
    .command("flaky")
    .description("tests that fail intermittently across recent runs")
    .argument("<pipeline>", "pipeline id, name, or definition URL")
    .option("--runs <n>", "recent completed runs to inspect", int("--runs"), 20)
    .option("--branch <branch>", "only this branch (recommended, e.g. main)")
    .option("--top <n>", "tests to report", int("--top"), 20)
    .option("--min-failures <n>", "minimum failures to be listed", int("--min-failures"), 1)
    .action(async (ref, opts, cmd) => {
      const c = client(cmd);
      const p = await resolvePipeline(c, parsePipelineRef(ref));
      const result = await findFlakyTests(c, p.id, { runs: opts.runs, branch: opts.branch, top: opts.top, minFailures: opts.minFailures });
      emit(cmd, { pipelineName: p.name, ...result });
    });

  // ---- analyze -----------------------------------------------------------
  program
    .command("analyze")
    .description("one-shot triage of a run: summary, failures with log snippets, failed tests, and diff vs last good run")
    .argument("<run>", "build id or build results URL")
    .option("--context <n>", "lines of context around each error", int("--context"), 6)
    .option("--no-diff", "skip the comparison with the last good run")
    .option("--no-tests", "skip test results")
    .action(async (ref, opts, cmd) => {
      const { c, build } = await loadRun(cmd, ref);
      const summary = compactBuild(build);
      const records = await getTimeline(c, build.id);
      const failed = build.result !== "succeeded";
      const [failures, tests] = await Promise.all([
        failed ? analyzeFailures(c, build, { context: opts.context, maxSnippets: 3, maxFailures: 6 }, records) : undefined,
        opts.tests ? getTestSummary(c, build.id, { top: 25, maxStackLines: 8 }).catch((e) => ({ error: String(e.message ?? e) })) : undefined,
      ]);
      const diff =
        failed && opts.diff && build.status === "completed"
          ? await diffRuns(c, build, { failureReport: failures, records, includeTests: opts.tests }).catch((e) => ({ error: String(e.message ?? e) }))
          : undefined;

      const nextSteps: string[] = [];
      for (const f of failures?.failures ?? []) if (f.hint) nextSteps.push(f.hint);
      if (tests && "results" in tests && tests.results.length) nextSteps.push(`adopipe run tests ${build.id} --top 200`);
      if (tests && "results" in tests && tests.results.length) nextSteps.push(`adopipe run artifacts ${build.id}`);
      if (build.definition) nextSteps.push(`adopipe pipeline trends ${build.definition.id} --branch ${summary.branch ?? "main"}`);
      if (tests && "hasTests" in tests && tests.hasTests && build.definition) {
        nextSteps.push(`adopipe pipeline flaky ${build.definition.id} --branch ${summary.branch ?? "main"}`);
      }

      const { signatures: _s, ...failureOut } = failures ?? ({} as any);
      emit(cmd, {
        run: summary,
        note:
          build.status !== "completed"
            ? `Run is ${build.status}; results are partial.`
            : !failed
              ? "Run succeeded."
              : undefined,
        failures: failures ? failureOut : undefined,
        tests: tests && "hasTests" in tests && !tests.hasTests ? { hasTests: false } : tests,
        diffVsLastGood: diff,
        nextSteps: [...new Set(nextSteps)].slice(0, 8),
      });
    });

  return program;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s + "\n"));
  const program = buildProgram(deps);
  program.configureOutput({
    writeOut: (s) => (deps.stdout ?? ((x: string) => process.stdout.write(x)))(s.replace(/\n$/, "")),
    writeErr: () => {}, // usage errors are reported as JSON below
  });
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return 0;
      stderr(JSON.stringify(new AdoError("USAGE", e.message.replace(/^error: /, "")).toJSON()));
      return EXIT_CODES.USAGE;
    }
    if (e instanceof AdoError) {
      stderr(JSON.stringify(e.toJSON()));
      return EXIT_CODES[e.code];
    }
    stderr(JSON.stringify({ error: { code: "INTERNAL", message: (e as Error)?.message ?? String(e) } }));
    return 1;
  }
}

// Run when executed directly (also via an npm bin symlink).
const invokedPath = process.argv[1] ? safeRealpath(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  loadEnvFiles(process.env);
  // exitCode (not process.exit) so buffered stdout on pipes is fully flushed.
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}

function safeRealpath(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
