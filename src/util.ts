/** Run `fn` over items with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function truncateText(s: string | undefined, maxChars: number): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `…[+${s.length - maxChars} chars]`;
}

export function truncateLines(s: string | undefined, maxLines: number): string | undefined {
  if (s === undefined) return undefined;
  const lines = s.split(/\r?\n/);
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join("\n") + `\n…[+${lines.length - maxLines} lines]`;
}

/**
 * Normalise an error message into a stable signature so the "same" error can be matched across runs:
 * strips GUIDs, hex hashes, numbers, timestamps, temp paths and quoted values.
 */
export function errorSignature(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<guid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/([a-z]:)?[\\/](?:[^\s\\/'"]+[\\/])+/g, "<path>/")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
