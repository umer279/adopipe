import type { AdoClient } from "../client.js";
import { AdoError } from "../errors.js";

export interface RawIssue {
  type: "error" | "warning" | string;
  category?: string;
  message: string;
  data?: Record<string, string>;
}

export interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string; // Stage | Phase | Job | Task | Checkpoint | ...
  name: string;
  identifier?: string;
  state?: string; // pending | inProgress | completed
  result?: string | null; // succeeded | succeededWithIssues | failed | canceled | skipped | abandoned
  startTime?: string | null;
  finishTime?: string | null;
  order?: number;
  attempt?: number;
  errorCount?: number;
  warningCount?: number;
  workerName?: string | null;
  log?: { id: number } | null;
  issues?: RawIssue[] | null;
}

export async function getTimeline(client: AdoClient, buildId: number): Promise<TimelineRecord[]> {
  try {
    const { data } = await client.getJson<{ records?: TimelineRecord[] } | null>(`_apis/build/builds/${buildId}/timeline`);
    return data?.records ?? [];
  } catch (e) {
    // A build that has not started yet has no timeline.
    if (e instanceof AdoError && e.code === "NOT_FOUND") return [];
    throw e;
  }
}
