import { AdoError } from "./errors.js";

export interface RunRef {
  buildId: number;
  org?: string; // base org URL when parsed from a URL
  project?: string;
}

/**
 * Accepts:
 *  - "123"
 *  - https://dev.azure.com/org/project/_build/results?buildId=123[&view=...]
 *  - https://org.visualstudio.com/project/_build/results?buildId=123
 *  - https://host/collection/project/_build/results?buildId=123 (Azure DevOps Server)
 */
export function parseRunRef(input: string): RunRef {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { buildId: Number(s) };

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new AdoError("USAGE", `Invalid run reference "${input}": expected a build id or a build results URL`);
  }
  const idParam = url.searchParams.get("buildId");
  if (!idParam || !/^\d+$/.test(idParam)) {
    throw new AdoError("USAGE", `URL "${input}" has no buildId query parameter`);
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const buildIdx = segments.indexOf("_build");
  if (buildIdx < 1) throw new AdoError("USAGE", `Could not find project in URL "${input}"`);

  const project = segments[buildIdx - 1];
  let org: string;
  if (/\.visualstudio\.com$/i.test(url.hostname)) {
    org = `${url.protocol}//${url.host}`;
  } else {
    const orgSegments = segments.slice(0, buildIdx - 1);
    if (!orgSegments.length) throw new AdoError("USAGE", `Could not find organization in URL "${input}"`);
    org = `${url.protocol}//${url.host}/${orgSegments.map(encodeURIComponent).join("/")}`;
  }
  return { buildId: Number(idParam), org, project };
}

export type PipelineRef = { id: number } | { name: string };

export function parsePipelineRef(input: string): PipelineRef {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { id: Number(s) };
  try {
    const url = new URL(s);
    const id = url.searchParams.get("definitionId");
    if (id && /^\d+$/.test(id)) return { id: Number(id) };
  } catch {
    /* not a URL */
  }
  return { name: s };
}
