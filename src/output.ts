export type Format = "json" | "text";

export interface OutputOptions {
  format: Format;
  pretty: boolean;
  maxChars: number; // 0 = unlimited
}

// [max string chars, max array items, max object depth]
const LEVELS: [number, number, number][] = [
  [4000, 300, Infinity],
  [2000, 150, Infinity],
  [1000, 80, Infinity],
  [600, 40, Infinity],
  [300, 20, Infinity],
  [200, 10, Infinity],
  [120, 5, Infinity],
  [80, 3, 6],
  [60, 2, 4],
  [40, 1, 3],
  [30, 1, 2],
];

function shrink(v: unknown, strMax: number, arrMax: number, depth: number): unknown {
  if (typeof v === "string") {
    return v.length > strMax ? v.slice(0, strMax) + `…[+${v.length - strMax} chars]` : v;
  }
  if (Array.isArray(v)) {
    if (depth <= 0) return `…[array of ${v.length}]`;
    const kept = v.slice(0, arrMax).map((x) => shrink(x, strMax, arrMax, depth - 1));
    if (v.length > arrMax) kept.push(`…[+${v.length - arrMax} more items]`);
    return kept;
  }
  if (v && typeof v === "object") {
    if (depth <= 0) return "…[object]";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = shrink(x, strMax, arrMax, depth - 1);
    return out;
  }
  return v;
}

/**
 * Shrink long strings and arrays step by step until the serialized output fits `maxChars`.
 * Truncation is always explicit in the data (…[+N chars] / …[+N more items]).
 */
export function fitBudget(value: unknown, maxChars: number, serialize: (v: unknown) => string): { text: string; truncated: boolean } {
  let text = serialize(value);
  if (!maxChars || text.length <= maxChars) return { text, truncated: false };
  const meta = { maxChars, hint: "Output was shortened to fit --max-chars. Narrow the query or raise --max-chars (0 = unlimited)." };
  for (const [s, a, d] of LEVELS) {
    const shrunk = shrink(value, s, a, d);
    const withMeta = shrunk && typeof shrunk === "object" && !Array.isArray(shrunk) ? { ...(shrunk as object), _truncated: meta } : shrunk;
    text = serialize(withMeta);
    if (text.length <= maxChars) return { text, truncated: true };
  }
  // Still too big: return valid output that says so, rather than cutting mid-structure.
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : undefined;
  return { text: serialize({ _truncated: { ...meta, note: "Output does not fit even after shrinking.", topLevelKeys: keys } }), truncated: true };
}

export function renderText(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  const lines: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === "object") {
        const body = renderText(item, indent + "  ").replace(/^\s+/, "");
        lines.push(`${indent}- ${body}`);
      } else {
        lines.push(`${indent}- ${String(item)}`);
      }
    }
    return lines.join("\n");
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null) continue;
    if (typeof x === "object") {
      if (Array.isArray(x) && !x.length) continue;
      if (Array.isArray(x) && x.every((i) => typeof i !== "object")) {
        // Log lines and other string lists read best as a plain block.
        lines.push(`${indent}${k}:`);
        for (const i of x) lines.push(`${indent}  ${String(i)}`);
        continue;
      }
      lines.push(`${indent}${k}:`);
      lines.push(renderText(x, indent + "  "));
    } else {
      lines.push(`${indent}${k}: ${String(x)}`);
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

export function formatOutput(value: unknown, opts: OutputOptions): string {
  const serialize =
    opts.format === "text" ? (v: unknown) => renderText(v) : (v: unknown) => JSON.stringify(v, null, opts.pretty ? 2 : undefined);
  return fitBudget(value, opts.maxChars, serialize).text;
}
