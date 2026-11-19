export interface Snippet {
  startLine: number; // 1-based, inclusive
  endLine: number; // inclusive
  matchLines: number[];
  lines: string[];
}

interface Pattern {
  re: RegExp;
  score: number;
}

// Higher score = more likely to be the real cause. ADO's generic "Process completed with exit code"
// line scores low so that the actual compiler/test/script error ranks above it.
const PATTERNS: Pattern[] = [
  { re: /##\[error\](?!Process completed with exit code|Bash exited with code|PowerShell exited with code|Script failed with)/i, score: 10 },
  { re: /^\s*error\s+[A-Z]{1,6}\d{2,6}\b|:\s*error\s+[A-Z]{1,6}\d{2,6}:/i, score: 9 }, // TS2304, CS0103, MSB3073
  { re: /\bnpm ERR!|\bERR_PNPM_|\byarn error\b|error Command failed/i, score: 8 },
  { re: /Traceback \(most recent call last\)|^\s*\w+(Error|Exception):\s|Unhandled exception|panic:/, score: 8 },
  { re: /\bFAILED\b|^\s*FAIL\s|✕|✗|\btests? failed\b|\bAssertionError\b|\bexpected\b.*\b(to|but)\b/i, score: 7 },
  { re: /\bfatal(:| error)\b|\bBUILD FAILED\b|\bcompilation failed\b|\bcould not\b.*\b(find|resolve|load)\b/i, score: 7 },
  { re: /(^|[\s:[(])error(\[|\]|:|\s)/i, score: 6 },
  { re: /\bdenied\b|\bunauthori[sz]ed\b|\bforbidden\b|\btimed? ?out\b|\bnot found\b/i, score: 4 },
  { re: /##\[error\]/i, score: 3 },
  { re: /exit(ed)? (with )?code [1-9]\d*|exit status [1-9]/i, score: 2 },
];

// Lines that look like errors but are not.
const NOISE = [
  /\b0 errors?\b|\berrors?: 0\b|\b0 failed\b|\bfailed: 0\b|Failed:\s+0\b/i,
  /-ErrorAction|\$ErrorActionPreference|set -e\b|errorlevel/i,
  /\b(error|failure)s?\.(ts|js|py|cs|go|rb|java|log|txt)\b/i,
  /--fail-on|continueOnError|failOnStderr|treatWarningsAsErrors/i,
  /^##\[(section|command|group|endgroup)\]/i,
];

export function scoreLine(line: string): number {
  if (NOISE.some((n) => n.test(line))) return 0;
  let best = 0;
  for (const p of PATTERNS) if (p.score > best && p.re.test(line)) best = p.score;
  return best;
}

export interface ExtractOptions {
  context?: number; // lines before/after each match
  maxSnippets?: number;
  maxLinesPerSnippet?: number;
  firstLineNumber?: number; // line number of lines[0], default 1
  minScore?: number;
}

/**
 * Find error-looking lines and return merged context windows, ranked by score,
 * returned in log order.
 */
export function extractErrors(lines: string[], opts: ExtractOptions = {}): { snippets: Snippet[]; totalMatches: number } {
  const context = opts.context ?? 5;
  const maxSnippets = opts.maxSnippets ?? 5;
  const maxLines = opts.maxLinesPerSnippet ?? 60;
  const base = opts.firstLineNumber ?? 1;
  const minScore = opts.minScore ?? 2;

  const matches: { idx: number; score: number }[] = [];
  const seen = new Set<string>();
  lines.forEach((line, idx) => {
    const score = scoreLine(line);
    if (score < minScore) return;
    const key = line.trim().replace(/\d+/g, "#");
    if (seen.has(key)) return; // repeated identical errors add no information
    seen.add(key);
    matches.push({ idx, score });
  });
  if (!matches.length) return { snippets: [], totalMatches: 0 };

  // Merge matches into windows.
  type Win = { start: number; end: number; matches: number[]; score: number };
  const windows: Win[] = [];
  for (const m of matches) {
    const start = Math.max(0, m.idx - context);
    const end = Math.min(lines.length - 1, m.idx + context);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1 && end - last.start < maxLines) {
      last.end = Math.max(last.end, end);
      last.matches.push(m.idx);
      last.score = Math.max(last.score, m.score) + 0.1; // dense clusters rank slightly higher
    } else {
      windows.push({ start, end, matches: [m.idx], score: m.score });
    }
  }

  // Keep the best windows; ties go to the earliest (first failure is usually the cause),
  // but always keep the last window too since build tools print summaries at the end.
  const ranked = windows.map((w, i) => ({ w, i })).sort((a, b) => b.w.score - a.w.score || a.i - b.i);
  const chosen = new Set(ranked.slice(0, maxSnippets).map((x) => x.i));
  if (windows.length > maxSnippets && maxSnippets > 1 && !chosen.has(windows.length - 1)) {
    const worst = [...chosen].sort((a, b) => windows[a].score - windows[b].score || b - a)[0];
    chosen.delete(worst);
    chosen.add(windows.length - 1);
  }

  const snippets = [...chosen]
    .sort((a, b) => a - b)
    .map((i) => {
      const w = windows[i];
      const end = Math.min(w.end, w.start + maxLines - 1);
      return {
        startLine: base + w.start,
        endLine: base + end,
        matchLines: w.matches.filter((m) => m <= end).map((m) => base + m),
        lines: lines.slice(w.start, end + 1),
      };
    });
  return { snippets, totalMatches: matches.length };
}
