import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdoClient } from "../client.js";
import { AdoError } from "../errors.js";

export interface RawArtifact {
  id: number;
  name: string;
  resource?: { type?: string; data?: string; downloadUrl?: string; properties?: Record<string, string> };
}

export interface CompactArtifact {
  id: number;
  name: string;
  type?: string;
  sizeBytes?: number;
}

export function compactArtifact(a: RawArtifact): CompactArtifact {
  const size = Number(a.resource?.properties?.artifactsize);
  return {
    id: a.id,
    name: a.name,
    type: a.resource?.type,
    ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {}),
  };
}

export async function listArtifacts(client: AdoClient, buildId: number): Promise<RawArtifact[]> {
  const { data } = await client.getJson<{ value: RawArtifact[] }>(`_apis/build/builds/${buildId}/artifacts`);
  return data.value ?? [];
}

export interface DownloadResult {
  buildId: number;
  artifact: string;
  zip: string;
  bytes: number;
  extractedTo?: string;
}

/**
 * Download one artifact as a zip into outDir/<name>.zip and optionally extract it into outDir.
 * Uses the project-scoped endpoint, so the PAT is only ever sent to the configured org URL.
 */
export async function downloadArtifact(
  client: AdoClient,
  buildId: number,
  name: string,
  outDir: string,
  opts: { extract?: boolean } = {},
): Promise<DownloadResult> {
  const res = await client.getStream(`_apis/build/builds/${buildId}/artifacts`, { artifactName: name, $format: "zip" });
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") || type.includes("text/html")) {
    throw new AdoError("API", `Expected a zip for artifact "${name}" but got ${type || "no content type"}.`, res.status);
  }
  if (!res.body) throw new AdoError("API", `Empty response for artifact "${name}".`, res.status);

  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const zip = join(dir, `${safeName(name)}.zip`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zip));
  const bytes = (await stat(zip)).size;

  const result: DownloadResult = { buildId, artifact: name, zip, bytes };
  if (opts.extract) {
    await extractZip(zip, dir);
    result.extractedTo = dir;
  }
  return result;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

const execFileP = promisify(execFile);

/** Extract with the OS tools (no npm dependency): Windows bsdtar reads zips; elsewhere unzip. */
export async function extractZip(zip: string, dir: string): Promise<void> {
  const [cmd, args] =
    process.platform === "win32"
      ? // Use System32 tar explicitly: Git's GNU tar may come first on PATH and cannot read zips.
        [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dir]]
      : ["unzip", ["-o", "-q", zip, "-d", dir]];
  try {
    await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new AdoError("API", `Downloaded ${zip} but could not extract it: ${(e as Error).message}`, undefined, "Extract the zip manually.");
  }
}
