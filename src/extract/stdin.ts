import type { Readable } from "node:stream";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Read a stream to the end with bounded memory. Past maxBytes the first 40% and last 60% are
 * kept (head and tail ring buffers) and the middle is dropped: conclusions come last.
 */
export async function readAll(stream: Readable, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const headMax = Number.isFinite(maxBytes) ? Math.floor(maxBytes * 0.4) : Infinity;
  const tailMax = Number.isFinite(maxBytes) ? maxBytes - headMax : Infinity;
  const head: Buffer[] = [];
  let headLen = 0;
  let tail: Buffer[] = [];
  let tailLen = 0;
  let dropped = false;
  for await (const c of stream) {
    let buf = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
    if (headLen < headMax) {
      const take = Math.min(buf.length, headMax - headLen);
      head.push(buf.subarray(0, take));
      headLen += take;
      buf = buf.subarray(take);
    }
    if (!buf.length) continue;
    tail.push(buf);
    tailLen += buf.length;
    while (tailLen > tailMax) {
      dropped = true;
      const over = tailLen - tailMax;
      const first = tail[0]!;
      if (first.length <= over) {
        tail.shift();
        tailLen -= first.length;
      } else {
        tail[0] = first.subarray(over);
        tailLen -= over;
      }
    }
  }
  tail = tail.filter((b) => b.length);
  const mid = dropped ? "\n\n[...]\n\n" : "";
  return Buffer.concat(head).toString("utf8") + mid + Buffer.concat(tail).toString("utf8");
}

/** Normalize raw agent output: BOM, CRLF, ANSI colors, outer whitespace. */
export function normalizeInput(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(ANSI, "").trim();
}

/** Keep head and tail; the conclusion is usually at the end. */
export function truncateMiddle(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return { text: `${text.slice(0, head)}\n\n[...]\n\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Keeps at most maxChars x 4 bytes (UTF-8 worst case) as head and tail, then truncates by characters. */
export async function extractStdin(stream: Readable, maxChars: number) {
  const cap = Number.isFinite(maxChars) ? maxChars * 4 : Number.POSITIVE_INFINITY;
  const text = normalizeInput(await readAll(stream, cap));
  return { ...truncateMiddle(text, maxChars), chars: text.length };
}
