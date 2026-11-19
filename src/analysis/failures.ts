import type { AdoClient } from "../client.js";
import type { RawBuild } from "../api/builds.js";
import { getTimeline, type TimelineRecord } from "../api/timeline.js";
import { getLogLines, listLogs } from "../api/logs.js";
import { compactIssues, findFailedSteps } from "./timelineTree.js";
import { extractErrors, type Snippet } from "./errorExtract.js";
import { errorSignature, mapLimit, truncateText } from "../util.js";

export interface FailureEntry {
  path: string;
  type: string;
  result?: string;
  logId?: number;
  issues?: { type: string; message: string }[];
  snippets?: Snippet[];
  tail?: { startLine: number; lines: string[] };
  logLines?: number;
  scannedFromLine?: number;
  hint?: string;
}

export interface FailureReport {
  buildId: number;
  result?: string;
  status?: string;
  failedCount: number;
  buildIssues?: string[]; // e.g. YAML validation errors that prevent any job from running
  failures: FailureEntry[];
  signatures: string[];
}

export interface FailureOptions {
  context?: number;
  maxSnippets?: number;
  maxFailures?: number;
  maxScanLines?: number; // only scan the last N lines of very large logs
  includeLogs?: boolean;
}

export async function analyzeFailures(
  client: AdoClient,
  build: RawBuild,
  opts: FailureOptions = {},
  records?: TimelineRecord[],
): Promise<FailureReport> {
  const context = opts.context ?? 8;
  const maxSnippets = opts.maxSnippets ?? 4;
  const maxFailures = opts.maxFailures ?? 10;
  const maxScan = opts.maxScanLines ?? 20000;
  const includeLogs = opts.includeLogs ?? true;

  records ??= await getTimeline(client, build.id);
  const failed = findFailedSteps(records);

  const validation = ((build as any).validationResults ?? []) as { result?: string; message?: string }[];
  const buildIssues = validation.filter((v) => v.result === "error" && v.message).map((v) => truncateText(v.message!, 1000)!);

  const logInfo = includeLogs && failed.some((f) => f.logId) ? await listLogs(client, build.id).catch(() => []) : [];
  const lineCounts = new Map(logInfo.map((l) => [l.id, l.lineCount ?? 0]));

  const selected = failed.slice(0, maxFailures);
  const failures = await mapLimit(selected, 4, async (f): Promise<FailureEntry> => {
    const entry: FailureEntry = {
      path: f.path,
      type: f.type,
      result: f.result,
      logId: f.logId,
      issues: compactIssues(f.record),
    };
    if (includeLogs && f.logId) {
      const total = lineCounts.get(f.logId);
      const startLine = total && total > maxScan ? total - maxScan + 1 : undefined;
      try {
        const lines = await getLogLines(client, build.id, f.logId, { startLine });
        const first = startLine ?? 1;
        const { snippets } = extractErrors(lines, { context, maxSnippets, firstLineNumber: first });
        entry.logLines = total ?? lines.length;
        if (startLine) entry.scannedFromLine = startLine;
        if (snippets.length) {
          entry.snippets = snippets;
        } else {
          const tailLines = lines.slice(-20);
          entry.tail = { startLine: first + lines.length - tailLines.length, lines: tailLines };
        }
      } catch {
        /* a missing log should not hide the rest of the report */
      }
      entry.hint = `adopipe run logs ${build.id} --log ${f.logId} --grep "error|fail" --context 20`;
    }
    return entry;
  });

  const signatures = new Set<string>();
  for (const f of failures) {
    for (const i of f.issues ?? []) {
      if (i.type === "error" && !/^Process completed with exit code|exited with code/i.test(i.message)) {
        signatures.add(errorSignature(i.message));
      }
    }
    if (!(f.issues ?? []).some((i) => i.type === "error")) signatures.add(errorSignature(`${f.path}: ${f.result}`));
  }
  for (const m of buildIssues) signatures.add(errorSignature(m));

  return {
    buildId: build.id,
    result: build.result,
    status: build.status,
    failedCount: failed.length,
    buildIssues: buildIssues.length ? buildIssues : undefined,
    failures,
    signatures: [...signatures],
  };
}
