import { AdoError } from "./errors.js";
import type { Config } from "./config.js";

export const API_VERSION = "7.1";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface ClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AdoClient {
  private fetchImpl: typeof fetch;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;
  private auth: string;

  constructor(
    public config: Config,
    opts: ClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.auth = "Basic " + Buffer.from(":" + config.pat).toString("base64");
  }

  /** Build a project-scoped URL. `path` is relative to {org}/{project}/, e.g. "_apis/build/builds". */
  url(path: string, query: Query = {}, apiVersion = API_VERSION): string {
    const base = `${this.config.orgUrl}/${encodeURIComponent(this.config.project)}/${path.replace(/^\/+/, "")}`;
    const u = new URL(base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    u.searchParams.set("api-version", apiVersion);
    return u.toString();
  }

  private async request(url: string, accept: string): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { Authorization: this.auth, Accept: accept },
          redirect: "manual",
        });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt++);
          continue;
        }
        throw new AdoError("API", `Network error calling ${redact(url)}: ${(e as Error).message}`);
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        attempt++;
        await this.sleep(Math.min(delay, 30_000));
        continue;
      }

      // ADO answers bad credentials with 401, or with a redirect / 203 to a sign-in page.
      if (res.status === 401 || res.status === 403 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
        throw new AdoError(
          "AUTH",
          `Authentication failed (HTTP ${res.status}). Check AZURE_DEVOPS_PAT and that it has Build (Read) and Test Management (Read) scopes.`,
          res.status,
        );
      }
      if (res.status === 404) {
        const msg = await safeMessage(res);
        throw new AdoError("NOT_FOUND", msg ?? `Not found: ${redact(url)}`, 404);
      }
      if (!res.ok) {
        const msg = await safeMessage(res);
        throw new AdoError("API", msg ?? `HTTP ${res.status} from ${redact(url)}`, res.status);
      }
      return res;
    }
  }

  // One CLI invocation is short-lived and read-only, so identical GETs can safely share a response.
  private cache = new Map<string, Promise<{ data: any; continuationToken?: string }>>();

  getJson<T = any>(path: string, query: Query = {}, apiVersion?: string): Promise<{ data: T; continuationToken?: string }> {
    const url = this.url(path, query, apiVersion);
    let p = this.cache.get(url);
    if (!p) {
      p = this.fetchJson(url);
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return p;
  }

  private async fetchJson<T>(url: string): Promise<{ data: T; continuationToken?: string }> {
    const res = await this.request(url, "application/json");
    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AdoError("AUTH", "Received a non-JSON response (likely a sign-in page). Check AZURE_DEVOPS_PAT.", res.status);
    }
    return { data, continuationToken: res.headers.get("x-ms-continuationtoken") ?? undefined };
  }

  /** GET a list endpoint returning {count, value: T[]}, following continuation tokens up to `limit` items. */
  async list<T = any>(path: string, query: Query = {}, limit = Infinity, apiVersion?: string): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const { data, continuationToken } = await this.getJson<{ value: T[] }>(
        path,
        { ...query, continuationToken: token },
        apiVersion,
      );
      out.push(...(data.value ?? []));
      token = continuationToken;
    } while (token && out.length < limit);
    return out.slice(0, limit);
  }

  async getText(path: string, query: Query = {}, apiVersion?: string): Promise<string> {
    const res = await this.request(this.url(path, query, apiVersion), "text/plain");
    return res.text();
  }

  /** GET a binary resource (e.g. an artifact zip). Not cached; the caller consumes the body. */
  async getStream(path: string, query: Query = {}, accept = "application/zip", apiVersion?: string): Promise<Response> {
    return this.request(this.url(path, query, apiVersion), accept);
  }
}

function redact(url: string): string {
  return url.replace(/continuationToken=[^&]+/, "continuationToken=…");
}

async function safeMessage(res: Response): Promise<string | undefined> {
  try {
    const j = JSON.parse(await res.text());
    return typeof j?.message === "string" ? j.message : undefined;
  } catch {
    return undefined;
  }
}
