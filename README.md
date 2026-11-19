# adopipe

A command-line tool for reading and analyzing **Azure DevOps pipeline runs**, built for AI agents. It prints compact JSON with explicit truncation, pulls the error snippets out of logs, summarizes test failures, compares a run with the last good run, and computes pass-rate trends and flaky tests.

## Install
```sh
npm install
npm run build
npm link          # puts `adopipe` on PATH (or run: node dist/cli.js ...)
```
Requires Node 20 or later.

## Configure
```sh
export AZURE_DEVOPS_PAT=xxxxx          # scopes: Build (Read), Test Management (Read)
export AZURE_DEVOPS_ORG=myorg          # or https://dev.azure.com/myorg
export AZURE_DEVOPS_PROJECT="My Project"
```
PowerShell: `$env:AZURE_DEVOPS_PAT = "xxxxx"`, and so on. `--org` and `--project` override the env vars. A full build URL carries its own org and project.

You can also put these variables in a `.env` file in the current directory, or in `~/.adopipe.env` for all directories:
```ini
AZURE_DEVOPS_PAT=xxxxx
AZURE_DEVOPS_ORG=https://tfs.corp/tfs/DefaultCollection
AZURE_DEVOPS_PROJECT="My Project"
```
Precedence: shell environment, then `./.env`, then `~/.adopipe.env`. Only the `AZURE_DEVOPS_*` variables above are read from these files. Add `.env` to `.gitignore`.

## Use
```sh
adopipe analyze "https://dev.azure.com/myorg/My%20Project/_build/results?buildId=1234"
adopipe runs list --pipeline web-ci --result failed --top 5
adopipe run logs 1234 --task "unit tests" --grep "error|fail" --context 10
adopipe run diff 1234                     # against the last good run on the same branch
adopipe run artifacts 1234 --download test-results --out ./artifacts --extract
adopipe pipeline trends web-ci --branch main
adopipe pipeline flaky web-ci --branch main --runs 30
```
Add `--pretty` for indented JSON, or `--format text` for a readable layout.

See **[AGENTS.md](AGENTS.md)** for the full command reference, output conventions and the triage workflow. It is written to be pasted into an agent's instructions.

## Develop
```sh
npm test          # vitest: unit tests + end-to-end CLI tests against a mocked Azure DevOps API
npm run typecheck
npm run dev -- analyze 1234   # run from source with tsx
```

### Layout
- `src/cli.ts`: commands, global flags, JSON errors and exit codes
- `src/client.ts`: REST client with PAT auth, retry on 429/5xx, continuation-token paging and a per-run GET cache
- `src/api/*`: thin wrappers over the Build and Test REST APIs (7.1)
- `src/analysis/*`: timeline tree, error extraction, failures, tests, diff, trends, flaky
- `src/output.ts`: output budget (`--max-chars`) and text renderer
