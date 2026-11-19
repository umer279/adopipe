import type { TimelineRecord } from "../api/timeline.js";
import { durationSec } from "../api/builds.js";
import { truncateText } from "../util.js";

export interface TimelineNode {
  name: string;
  type: string;
  state?: string;
  result?: string;
  durationSec?: number;
  logId?: number;
  attempt?: number;
  worker?: string;
  errors?: number;
  warnings?: number;
  issues?: { type: string; message: string }[];
  children?: TimelineNode[];
}

const BAD_RESULTS = new Set(["failed", "canceled", "abandoned"]);

export function isBad(r: TimelineRecord): boolean {
  return !!r.result && BAD_RESULTS.has(r.result);
}

export function compactIssues(r: TimelineRecord, maxChars = 1000) {
  const issues = (r.issues ?? []).filter((i) => i.type === "error" || i.type === "warning");
  return issues.length ? issues.map((i) => ({ type: i.type, message: truncateText(i.message, maxChars)! })) : undefined;
}

/**
 * ADO returns retried jobs as multiple records with the same identifier; keep only the latest attempt
 * so analysis reflects the final outcome.
 */
export function latestAttempts(records: TimelineRecord[]): TimelineRecord[] {
  const best = new Map<string, TimelineRecord>();
  for (const r of records) {
    if (!r.identifier || (r.type !== "Stage" && r.type !== "Phase" && r.type !== "Job")) continue;
    const key = `${r.type}:${r.identifier}`;
    const prev = best.get(key);
    if (!prev || (r.attempt ?? 1) > (prev.attempt ?? 1)) best.set(key, r);
  }
  const dropped = new Set<string>();
  for (const r of records) {
    if (!r.identifier || (r.type !== "Stage" && r.type !== "Phase" && r.type !== "Job")) continue;
    if (best.get(`${r.type}:${r.identifier}`) !== r) dropped.add(r.id);
  }
  if (!dropped.size) return records;
  const byId = new Map(records.map((r) => [r.id, r]));
  const underDropped = (r: TimelineRecord): boolean => {
    for (let cur: TimelineRecord | undefined = r; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (dropped.has(cur.id)) return true;
    }
    return false;
  };
  return records.filter((r) => !underDropped(r));
}

export function buildTree(records: TimelineRecord[], opts: { failedOnly?: boolean } = {}): TimelineNode[] {
  const recs = latestAttempts(records);
  const byParent = new Map<string, TimelineRecord[]>();
  const ids = new Set(recs.map((r) => r.id));
  const roots: TimelineRecord[] = [];
  for (const r of recs) {
    if (r.parentId && ids.has(r.parentId)) {
      const list = byParent.get(r.parentId) ?? [];
      list.push(r);
      byParent.set(r.parentId, list);
    } else {
      roots.push(r);
    }
  }
  const sortRecs = (a: TimelineRecord, b: TimelineRecord) => (a.order ?? 0) - (b.order ?? 0);

  const hasBadDescendant = (r: TimelineRecord): boolean =>
    isBad(r) || (r.errorCount ?? 0) > 0 || (byParent.get(r.id) ?? []).some(hasBadDescendant);

  const toNodes = (list: TimelineRecord[]): TimelineNode[] => {
    const out: TimelineNode[] = [];
    for (const r of [...list].sort(sortRecs)) {
      if (r.type === "Checkpoint" || r.type.startsWith("Checkpoint.")) continue;
      if (opts.failedOnly && !hasBadDescendant(r)) continue;
      const kids = toNodes(byParent.get(r.id) ?? []);
      // Phases are a wrapper layer between Stage and Job; flatten them away.
      if (r.type === "Phase") {
        out.push(...kids);
        continue;
      }
      out.push({
        name: r.name,
        type: r.type,
        state: r.state !== "completed" ? r.state : undefined,
        result: r.result ?? undefined,
        durationSec: durationSec(r.startTime ?? undefined, r.finishTime ?? undefined),
        logId: r.log?.id,
        attempt: r.attempt && r.attempt > 1 ? r.attempt : undefined,
        worker: r.type === "Job" ? (r.workerName ?? undefined) : undefined,
        errors: r.errorCount || undefined,
        warnings: r.warningCount || undefined,
        issues: compactIssues(r, 500),
        children: kids.length ? kids : undefined,
      });
    }
    return out;
  };
  return toNodes(roots);
}

export interface FailedStep {
  path: string; // "Stage > Job > Task"
  type: string;
  result?: string;
  logId?: number;
  recordId: string;
  record: TimelineRecord;
}

/** Path of names from the root to this record, skipping Phase wrappers. */
export function recordPath(r: TimelineRecord, byId: Map<string, TimelineRecord>): string {
  const names: string[] = [];
  let cur: TimelineRecord | undefined = r;
  while (cur) {
    if (cur.type !== "Phase") names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return names.join(" > ");
}

/**
 * The most specific failing records: failed Tasks, plus failed Jobs/Stages that have no failed
 * task beneath them (e.g. agent lost, timeout, cancelled, or a failing condition/approval).
 */
export function findFailedSteps(records: TimelineRecord[]): FailedStep[] {
  const recs = latestAttempts(records);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const children = new Map<string, TimelineRecord[]>();
  for (const r of recs) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);

  const failedBelow = (r: TimelineRecord): boolean =>
    (children.get(r.id) ?? []).some((c) => (isBad(c) && c.result !== "canceled") || failedBelow(c));

  const out: FailedStep[] = [];
  for (const r of recs) {
    if (r.type === "Checkpoint" || r.type.startsWith("Checkpoint.")) continue;
    const bad = isBad(r) || (r.type === "Task" && (r.errorCount ?? 0) > 0 && r.result !== "succeeded");
    if (!bad) continue;
    if (r.type !== "Task" && failedBelow(r)) continue;
    // A cancelled task under a failed job is a consequence, not a cause.
    if (r.result === "canceled" && r.type === "Task") continue;
    out.push({ path: recordPath(r, byId), type: r.type, result: r.result ?? undefined, logId: r.log?.id, recordId: r.id, record: r });
  }
  // Order by start time so the first failure comes first.
  return out.sort((a, b) => (a.record.startTime ?? "").localeCompare(b.record.startTime ?? ""));
}

/** Leaf jobs keyed by "Stage > Job" with result and duration, for comparing runs. */
export function jobSummary(records: TimelineRecord[]): Map<string, { result?: string; durationSec?: number }> {
  const recs = latestAttempts(records);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const out = new Map<string, { result?: string; durationSec?: number }>();
  for (const r of recs) {
    if (r.type !== "Job" && r.type !== "Stage") continue;
    out.set(`${r.type}: ${recordPath(r, byId)}`, {
      result: r.result ?? undefined,
      durationSec: durationSec(r.startTime ?? undefined, r.finishTime ?? undefined),
    });
  }
  return out;
}
