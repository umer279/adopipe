import { AdoError } from "./errors.js";

export interface Config {
  orgUrl: string; // e.g. https://dev.azure.com/myorg
  project: string;
  pat: string;
}

export interface ConfigInput {
  org?: string;
  project?: string;
  pat?: string;
}

/** Normalise an org name or URL into a base URL with no trailing slash. */
export function normalizeOrg(org: string): string {
  const trimmed = org.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://dev.azure.com/${encodeURIComponent(trimmed)}`;
}

export function resolveConfig(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Config {
  const pat = input.pat ?? env.AZURE_DEVOPS_PAT ?? env.AZURE_DEVOPS_EXT_PAT;
  const org = input.org ?? env.AZURE_DEVOPS_ORG;
  const project = input.project ?? env.AZURE_DEVOPS_PROJECT;

  const missing: string[] = [];
  if (!pat) missing.push("AZURE_DEVOPS_PAT");
  if (!org) missing.push("AZURE_DEVOPS_ORG (or --org, or pass a full build URL)");
  if (!project) missing.push("AZURE_DEVOPS_PROJECT (or --project, or pass a full build URL)");
  if (missing.length) {
    throw new AdoError("CONFIG", `Missing configuration: ${missing.join(", ")}`);
  }
  return { orgUrl: normalizeOrg(org!), project: project!, pat: pat! };
}
