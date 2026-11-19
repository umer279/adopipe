export interface Route {
  match: RegExp; // tested against pathname + search
  status?: number;
  json?: unknown;
  text?: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
  /** Return a different response per call (e.g. for retries / pagination). */
  sequence?: Omit<Route, "match" | "sequence">[];
}

export interface MockFetch {
  fetch: typeof fetch;
  calls: string[];
}

export function mockFetch(routes: Route[]): MockFetch {
  const calls: string[] = [];
  const counters = new Map<Route, number>();
  const fn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const target = decodeURIComponent(url.pathname) + url.search;
    calls.push(target);
    const route = routes.find((r) => r.match.test(target));
    if (!route) return new Response(JSON.stringify({ message: `no mock for ${target}` }), { status: 404 });
    let r: Omit<Route, "match" | "sequence"> = route;
    if (route.sequence) {
      const n = counters.get(route) ?? 0;
      counters.set(route, n + 1);
      r = route.sequence[Math.min(n, route.sequence.length - 1)];
    }
    const body = r.body ?? r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return new Response(body as BodyInit, { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const testConfig = { orgUrl: "https://dev.azure.com/acme", project: "Web App", pat: "secret" };

export const testEnv = {
  AZURE_DEVOPS_PAT: "secret",
  AZURE_DEVOPS_ORG: "acme",
  AZURE_DEVOPS_PROJECT: "Web App",
};

export async function runCli(argv: string[], routes: Route[], env: Record<string, string> = testEnv) {
  const { main } = await import("../src/cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const mf = mockFetch(routes);
  const code = await main(argv, { fetch: mf.fetch, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s), isTTY: false });
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), calls: mf.calls };
}
