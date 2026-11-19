import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Only these keys are taken from env files; anything else in a project's .env is ignored. */
export const ENV_KEYS = ["AZURE_DEVOPS_PAT", "AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PROJECT"] as const;

/**
 * Parse dotenv text: `KEY=value`, optional `export ` prefix, `#` comments,
 * single quotes (literal) and double quotes (supports \n, \t, \", \\).
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    let value: string;
    if (rest.startsWith('"')) {
      const end = findClosingQuote(rest);
      value = (end === -1 ? rest.slice(1) : rest.slice(1, end)).replace(/\\([nrt"\\])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
      );
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

function findClosingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

export interface LoadEnvOptions {
  cwd?: string;
  home?: string;
  read?: (path: string) => string | undefined;
}

const readIfExists = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Files checked, highest precedence first. Variables already set in `env` always win. */
export function envFilePaths(opts: LoadEnvOptions = {}): string[] {
  return [join(opts.cwd ?? process.cwd(), ".env"), join(opts.home ?? homedir(), ".adopipe.env")];
}

/**
 * Fill unset adopipe variables in `env` from ./.env, then ~/.adopipe.env.
 * Returns the paths that contributed at least one value.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env, opts: LoadEnvOptions = {}): string[] {
  const read = opts.read ?? readIfExists;
  const used: string[] = [];
  for (const path of envFilePaths(opts)) {
    const text = read(path);
    if (text === undefined) continue;
    const parsed = parseEnvText(text);
    let contributed = false;
    for (const key of ENV_KEYS) {
      if (parsed[key] !== undefined && parsed[key] !== "" && !env[key]) {
        env[key] = parsed[key];
        contributed = true;
      }
    }
    if (contributed) used.push(path);
  }
  return used;
}
