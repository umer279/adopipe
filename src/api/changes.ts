import type { AdoClient } from "../client.js";
import { AdoError } from "../errors.js";

export interface RawChange {
  id: string; // commit sha / changeset id
  message?: string;
  type?: string;
  author?: { displayName?: string; uniqueName?: string };
  timestamp?: string;
  location?: string;
  displayUri?: string;
  messageTruncated?: boolean;
}

export interface CompactChange {
  commit: string;
  author?: string;
  timestamp?: string;
  message: string;
  url?: string;
}

export function compactChange(c: RawChange): CompactChange {
  const firstLine = (c.message ?? "").split(/\r?\n/)[0].trim();
  return {
    commit: c.id,
    author: c.author?.displayName,
    timestamp: c.timestamp,
    message: firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine,
    url: c.displayUri,
  };
}

export async function getBuildChanges(client: AdoClient, buildId: number, top = 50): Promise<RawChange[]> {
  const { data } = await client.getJson<{ value: RawChange[] }>(`_apis/build/builds/${buildId}/changes`, { $top: top });
  return data.value ?? [];
}

/** Commits between two builds of the same pipeline (exclusive of `fromBuildId`, inclusive of `toBuildId`). */
export async function getChangesBetween(
  client: AdoClient,
  fromBuildId: number,
  toBuildId: number,
  top = 50,
): Promise<RawChange[]> {
  const query = { fromBuildId, toBuildId, $top: top };
  try {
    const { data } = await client.getJson<{ value: RawChange[] }>("_apis/build/changes", query);
    return data.value ?? [];
  } catch (e) {
    // This endpoint has been preview-only on some service versions.
    if (e instanceof AdoError && e.code === "API" && e.status === 400) {
      const { data } = await client.getJson<{ value: RawChange[] }>("_apis/build/changes", query, "7.1-preview.2");
      return data.value ?? [];
    }
    throw e;
  }
}
