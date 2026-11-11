/** `--from tagged`: the last <narrate>...</narrate> block in the input, for any agent. */

/** Past this size only the tail is scanned; the conclusion is at the end. */
export const TAG_SCAN_MAX = 2_000_000;

const OPEN = /<narrate>/gi;
const CLOSE = /<\/narrate>/gi;

/**
 * Every complete block, found in one pass with literal searches. An opener with no closer ends the
 * scan: no later opener can have one either, so unclosed tags cost O(n), not O(n^2).
 */
export function narrateBlocks(text: string): string[] {
  const s = text.length > TAG_SCAN_MAX ? text.slice(-TAG_SCAN_MAX) : text;
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    OPEN.lastIndex = pos;
    const o = OPEN.exec(s);
    if (!o) break;
    const from = o.index + o[0].length;
    CLOSE.lastIndex = from;
    const c = CLOSE.exec(s);
    if (!c) break;
    out.push(s.slice(from, c.index));
    pos = c.index + c[0].length;
  }
  return out;
}

export function extractTagged(text: string): string | null {
  let last: string | null = null;
  for (const b of narrateBlocks(text)) {
    const inner = b.trim();
    if (inner) last = inner;
  }
  return last;
}
