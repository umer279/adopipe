import type { AdoClient } from "../client.js";
import { AdoError } from "../errors.js";
import type { PipelineRef } from "../refs.js";
import { compactBuild, type RawBuild } from "./builds.js";

export interface RawDefinition {
  id: number;
  name: string;
  path?: string;
  queueStatus?: string;
  latestBuild?: RawBuild;
  latestCompletedBuild?: RawBuild;
  _links?: { web?: { href?: string } };
}

export async function listDefinitions(client: AdoClient, nameFilter?: string, top = 500): Promise<RawDefinition[]> {
  // The `name` parameter supports * wildcards; wrap plain text so it acts as "contains".
  const name = nameFilter ? (nameFilter.includes("*") ? nameFilter : `*${nameFilter}*`) : undefined;
  return client.list<RawDefinition>(
    "_apis/build/definitions",
    { name, includeLatestBuilds: true, queryOrder: "definitionNameAscending", $top: Math.min(top, 1000) },
    top,
  );
}

export function compactDefinition(d: RawDefinition) {
  const last = d.latestCompletedBuild ?? d.latestBuild;
  return {
    id: d.id,
    name: d.name,
    path: d.path,
    queueStatus: d.queueStatus,
    latestRun: last
      ? (({ id, number, status, result, branch, finishedAt }) => ({ id, number, status, result, branch, finishedAt }))(
          compactBuild(last),
        )
      : undefined,
  };
}

/** Resolve a pipeline id or name to {id, name}. Names match exactly (case-insensitive), then by unique substring. */
export async function resolvePipeline(client: AdoClient, ref: PipelineRef): Promise<{ id: number; name?: string }> {
  if ("id" in ref) return { id: ref.id };
  const defs = await listDefinitions(client, ref.name);
  const lower = ref.name.toLowerCase();
  const exact = defs.filter((d) => d.name.toLowerCase() === lower);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
  const candidates = exact.length ? exact : defs;
  if (candidates.length === 1) return { id: candidates[0].id, name: candidates[0].name };
  if (!candidates.length) {
    throw new AdoError("NOT_FOUND", `No pipeline matches "${ref.name}"`, undefined, "Run `adopipe pipelines list` to see pipelines.");
  }
  const list = candidates
    .slice(0, 10)
    .map((d) => `${d.id}: ${d.path && d.path !== "\\" ? d.path + "\\" : ""}${d.name}`)
    .join("; ");
  throw new AdoError("USAGE", `Pipeline name "${ref.name}" is ambiguous. Candidates: ${list}`, undefined, "Pass the numeric pipeline id.");
}
