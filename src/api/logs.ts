import type { AdoClient } from "../client.js";

export interface RawLogInfo {
  id: number;
  lineCount?: number;
  createdOn?: string;
  lastChangedOn?: string;
}

export async function listLogs(client: AdoClient, buildId: number): Promise<RawLogInfo[]> {
  const { data } = await client.getJson<{ value: RawLogInfo[] }>(`_apis/build/builds/${buildId}/logs`);
  return data.value ?? [];
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

export function cleanLine(line: string, keepTimestamps = false): string {
  let l = line.replace(/\r$/, "").replace(ANSI, "");
  if (!keepTimestamps) l = l.replace(TIMESTAMP, "");
  return l;
}

/** Fetch a log as lines (1-based line numbers map to index + startLine). */
export async function getLogLines(
  client: AdoClient,
  buildId: number,
  logId: number,
  opts: { startLine?: number; endLine?: number; keepTimestamps?: boolean } = {},
): Promise<string[]> {
  const text = await client.getText(`_apis/build/builds/${buildId}/logs/${logId}`, {
    startLine: opts.startLine,
    endLine: opts.endLine,
  });
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => cleanLine(l, opts.keepTimestamps));
}
