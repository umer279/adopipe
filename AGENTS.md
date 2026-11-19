# adopipe: Azure DevOps pipeline triage for agents

`adopipe` reads Azure DevOps pipeline (build) runs and prints **compact JSON** to stdout. Use it to work out why a run failed, whether a failure is new or flaky, and which commits are suspects.

## Setup (already done by the human)
- `AZURE_DEVOPS_PAT`: a PAT with **Build (Read)** and **Test Management (Read)**.
- `AZURE_DEVOPS_ORG` (name or URL) and `AZURE_DEVOPS_PROJECT`. These are optional when you pass a full build URL.
- Unset variables are also read from `./.env`, then `~/.adopipe.env`. Shell variables take precedence.

## Recommended workflow
1. **Start with `analyze`.** One call returns the run summary, failed steps with error snippets from the logs, failed tests, and a diff against the last successful run on the same branch.
   ```
   adopipe analyze https://dev.azure.com/org/proj/_build/results?buildId=1234
   adopipe analyze 1234
   ```
2. **Read the root cause** in `failures.failures[].issues` and `failures.failures[].snippets[].lines`. Snippets are ranked: real compiler, test or script errors rank above the generic `Process completed with exit code 1`.
3. **Drill into a log** when you need more context. Use the commands in `nextSteps`, for example:
   ```
   adopipe run logs 1234 --log 42 --grep "error|fail" --context 20
   adopipe run logs 1234 --task "unit tests" --tail 300
   adopipe run logs 1234 --log 42 --range 400-520
   ```
4. **Decide whether it is new, flaky or ongoing:**
   - `diffVsLastGood.commits`: commits since the last green run (the suspects).
   - `diffVsLastGood.errors.new` vs `.persisting`, and `diffVsLastGood.tests.newFailures`.
   - `adopipe pipeline flaky <pipelineId> --branch main`: a test classified as `flaky` is probably not caused by the change.
   - `adopipe pipeline trends <pipelineId> --branch main`: `history`, `currentStreak`, `brokeAt` (the first run of the current failing streak) and `recurringFailures`.

## Commands
| Command | Returns |
|---|---|
| `pipelines list [--filter x]` | Pipelines with their latest run |
| `runs list [--pipeline id\|name] [--branch b] [--result failed] [--top n]` | Recent runs, newest first |
| `run show <run>` | Run metadata (result, branch, commit, PR, duration, url) |
| `run timeline <run> [--failed-only]` | Stage > Job > Task tree with results, durations, `logId`, issues |
| `run logs <run>` | Without options, a list of logs mapped to step names |
| `run logs <run> --log <id> \| --task <name> [--grep re --context n \| --head n \| --tail n \| --range a-b]` | Log `blocks: [{startLine, lines[]}]` |
| `run failures <run> [--context n] [--no-logs]` | Failed steps, issues, error snippets |
| `run tests <run> [--outcome all\|Failed,...] [--top n]` | Test totals and failed tests with `errorMessage` and `stackTrace` |
| `run artifacts <run>` | Artifacts of the run (`name`, `type`, `sizeBytes`) |
| `run artifacts <run> --download <name> [--out dir] [--extract]` | Downloads one artifact as `<out>/<name>.zip` (default `./adopipe-artifacts/<buildId>`); `--extract` unzips it into `<out>` and keeps the zip. Prints `{zip, bytes, extractedTo?}` |
| `run diff <run> [--against <run>\|last-good]` | Commits, new/persisting/resolved errors, job result and duration changes, test changes |
| `pipeline trends <pipeline> [--top n] [--branch b]` | Pass rate, durations, streaks, `brokeAt`, recurring failing steps |
| `pipeline flaky <pipeline> [--runs n] [--branch b]` | Tests classified `flaky`, `recent-regression`, `consistently-failing` or `fixed` |
| `analyze <run>` | Everything above that matters for one failed run |

`<run>` is a build id or a build results URL. `<pipeline>` is a pipeline id, a name, or a URL with `definitionId=`.

## Output conventions
- JSON on stdout. Timestamps are ISO. Durations are in seconds (`durationSec`), except test `durationMs`.
- Log line numbers are 1-based and match `--range`. Per-line timestamps are stripped (`--timestamps` keeps them).
- **Truncation is always explicit**: `…[+N chars]`, `…[+N more items]`, and a top-level `_truncated` object. The default budget is 24000 chars. Raise it with `--max-chars 60000`, or use `--max-chars 0` for unlimited. Prefer narrowing the query (`--grep`, `--range`, `--top`).
- Histories (`history` fields) are **newest first**. Trends use `S/P/F/C` (succeeded, partiallySucceeded, failed, canceled). Flaky uses `F`/`.`.
- Flaky detection only fetches failed results. "Not failed" counts as passed or not run.

## Errors
Errors go to stderr as `{"error":{"code","message","status?","hint?"}}`.

| Exit | Code | Meaning |
|---|---|---|
| 0 | | ok |
| 1 | `USAGE` / `CONFIG` | Bad arguments or missing env vars. Fix the call. |
| 2 | `AUTH` / `API` | Bad or under-scoped PAT, or a service error. Tell the human; retrying will not help. |
| 3 | `NOT_FOUND` | Wrong id, project or org |
