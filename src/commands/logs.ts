import type { AdoClient } from "../client.js";
import { getLogLines, listLogs } from "../api/logs.js";
import { getTimeline, type TimelineRecord } from "../api/timeline.js";
import { recordPath } from "../analysis/timelineTree.js";
import { AdoError } from "../errors.js";

export interface LogOptions {
  log?: number;
  task?: string;
  head?: number;
  tail?: number;
  grep?: string;
  context?: number;
  range?: string; // "100-200"
  timestamps?: boolean;
  maxLogs?: number;
}

export interface LogBlock {
  startLine: number;
  lines: string[];
}

export function grepLines(lines: string[], pattern: RegExp, context: number, firstLine = 1, maxBlocks = 50): { blocks: LogBlock[]; matches: number } {
  const hits: number[] = [];
  lines.forEach((l, i) => pattern.test(l) && hits.push(i));
  const blocks: { s: number; e: number }[] = [];
  for (const h of hits) {
    const s = Math.max(0, h - context);
    const e = Math.min(lines.length - 1, h + context);
    const last = blocks[blocks.length - 1];
    if (last && s <= last.e + 1) last.e = Math.max(last.e, e);
    else blocks.push({ s, e });
  }
  return {
    matches: hits.length,
    blocks: blocks.slice(0, maxBlocks).map((b) => ({ startLine: firstLine + b.s, lines: lines.slice(b.s, b.e + 1) })),
  };
}

function parseRange(range: string): { start: number; end: number } {
  const m = /^(\d+)\s*[-:]\s*(\d+)$/.exec(range.trim());
  if (!m) throw new AdoError("USAGE", `--range must look like 100-200, got "${range}"`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end < start) throw new AdoError("USAGE", "--range end must be >= start");
  return { start, end };
}

export async function runLogs(client: AdoClient, buildId: number, opts: LogOptions) {
  const records = await getTimeline(client, buildId);
  const byId = new Map(records.map((r) => [r.id, r]));
  const byLog = new Map<number, TimelineRecord>();
  for (const r of records) if (r.log?.id && !byLog.has(r.log.id)) byLog.set(r.log.id, r);

  if (opts.log === undefined && !opts.task) {
    const logs = await listLogs(client, buildId);
    return {
      buildId,
      note: "Pass --log <logId> or --task <name> to read a log. Task logs are usually what you want; Job logs contain everything in the job.",
      logs: logs.map((l) => {
        const r = byLog.get(l.id);
        return { logId: l.id, lines: l.lineCount, step: r ? recordPath(r, byId) : undefined, type: r?.type, result: r?.result ?? undefined };
      }),
    };
  }

  let targets: { logId: number; record?: TimelineRecord }[];
  if (opts.log !== undefined) {
    targets = [{ logId: opts.log, record: byLog.get(opts.log) }];
  } else {
    const needle = opts.task!.toLowerCase();
    const matches = records.filter((r) => r.log?.id && r.name.toLowerCase().includes(needle));
    // Prefer failed matches, then tasks over jobs.
    matches.sort(
      (a, b) =>
        Number(b.result === "failed") - Number(a.result === "failed") ||
        Number(b.type === "Task") - Number(a.type === "Task") ||
        (a.startTime ?? "").localeCompare(b.startTime ?? ""),
    );
    if (!matches.length) {
      throw new AdoError("NOT_FOUND", `No step with a log matches "${opts.task}"`, undefined, `Run \`adopipe run logs ${buildId}\` to list logs.`);
    }
    targets = matches.slice(0, opts.maxLogs ?? 3).map((r) => ({ logId: r.log!.id, record: r }));
  }

  const range = opts.range ? parseRange(opts.range) : undefined;
  const results = [];
  for (const t of targets) {
    const lines = await getLogLines(client, buildId, t.logId, {
      startLine: range?.start,
      endLine: range?.end,
      keepTimestamps: opts.timestamps,
    });
    const first = range?.start ?? 1;
    const base = {
      logId: t.logId,
      step: t.record ? recordPath(t.record, byId) : undefined,
      result: t.record?.result ?? undefined,
      totalLines: range ? undefined : lines.length,
    };
    if (opts.grep) {
      let re: RegExp;
      try {
        re = new RegExp(opts.grep, "i");
      } catch (e) {
        throw new AdoError("USAGE", `Invalid --grep regex: ${(e as Error).message}`);
      }
      const { blocks, matches } = grepLines(lines, re, opts.context ?? 3, first);
      results.push({ ...base, grep: opts.grep, matches, blocks });
    } else if (opts.head) {
      results.push({ ...base, blocks: [{ startLine: first, lines: lines.slice(0, opts.head) }] });
    } else if (opts.tail || !range) {
      const n = opts.tail ?? 200;
      const slice = lines.slice(-n);
      results.push({
        ...base,
        note: opts.tail ? undefined : "Showing the last 200 lines. Use --tail, --head, --range or --grep to choose.",
        blocks: [{ startLine: first + lines.length - slice.length, lines: slice }],
      });
    } else {
      results.push({ ...base, blocks: [{ startLine: first, lines }] });
    }
  }
  return { buildId, logs: results };
}
