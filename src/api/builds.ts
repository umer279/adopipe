import type { AdoClient } from "../client.js";

export interface RawBuild {
  id: number;
  buildNumber: string;
  status: string; // inProgress | completed | cancelling | postponed | notStarted | none
  result?: string; // succeeded | partiallySucceeded | failed | canceled | none
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  definition?: { id: number; name: string; path?: string };
  requestedFor?: { displayName?: string; uniqueName?: string };
  triggerInfo?: Record<string, string>;
  repository?: { name?: string; type?: string; id?: string };
  uri?: string;
  _links?: { web?: { href?: string } };
  [k: string]: unknown;
}

export interface CompactBuild {
  id: number;
  number: string;
  pipeline?: { id: number; name: string };
  status: string;
  result?: string;
  branch?: string;
  commit?: string;
  reason?: string;
  pullRequest?: { id?: string; sourceBranch?: string; targetBranch?: string };
  requestedFor?: string;
  repository?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  url?: string;
}

export function shortBranch(ref?: string): string | undefined {
  return ref?.replace(/^refs\/heads\//, "");
}

export function fullBranch(branch?: string): string | undefined {
  if (!branch) return undefined;
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function durationSec(start?: string, finish?: string): number | undefined {
  if (!start || !finish) return undefined;
  const d = (Date.parse(finish) - Date.parse(start)) / 1000;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : undefined;
}

export function compactBuild(b: RawBuild): CompactBuild {
  const ti = b.triggerInfo ?? {};
  const pr =
    b.reason === "pullRequest" || ti["pr.number"]
      ? {
          id: ti["pr.number"],
          sourceBranch: shortBranch(ti["pr.sourceBranch"]),
          targetBranch: shortBranch(ti["pr.targetBranch"]),
        }
      : undefined;
  return {
    id: b.id,
    number: b.buildNumber,
    pipeline: b.definition ? { id: b.definition.id, name: b.definition.name } : undefined,
    status: b.status,
    result: b.result,
    branch: shortBranch(b.sourceBranch),
    commit: b.sourceVersion,
    reason: b.reason,
    pullRequest: pr,
    requestedFor: b.requestedFor?.displayName,
    repository: b.repository?.name,
    queuedAt: b.queueTime,
    startedAt: b.startTime,
    finishedAt: b.finishTime,
    durationSec: durationSec(b.startTime, b.finishTime),
    url: b._links?.web?.href,
  };
}

export async function getBuild(client: AdoClient, buildId: number): Promise<RawBuild> {
  const { data } = await client.getJson<RawBuild>(`_apis/build/builds/${buildId}`);
  return data;
}

export interface ListBuildsOptions {
  definitionId?: number;
  branch?: string;
  result?: string; // comma list: succeeded,failed,...
  status?: string; // inProgress,completed,...
  reason?: string;
  top?: number;
  order?: "queueTimeDescending" | "finishTimeDescending" | "startTimeDescending";
}

export async function listBuilds(client: AdoClient, opts: ListBuildsOptions = {}): Promise<RawBuild[]> {
  const top = opts.top ?? 20;
  return client.list<RawBuild>(
    "_apis/build/builds",
    {
      definitions: opts.definitionId,
      branchName: fullBranch(opts.branch),
      resultFilter: opts.result,
      statusFilter: opts.status,
      reasonFilter: opts.reason,
      queryOrder: opts.order ?? "queueTimeDescending",
      $top: Math.min(top, 5000),
    },
    top,
  );
}
