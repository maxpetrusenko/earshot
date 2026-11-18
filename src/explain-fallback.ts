import { CARDS_CSS } from "./explain-cards-css.js";
import { cleanText, cleanWords } from "./explain-util.js";
import { escapeHtml as e } from "./orca.js";

/**
 * The deterministic card for `--visual` when the model drew nothing (NO_IMAGE, a failed gate, an LLM error): a compact
 * "what changed" list built only from the reply's own headings and bullets, in the house style. No LLM, so it cannot
 * fail, and it is never empty: a reply without headings or bullets falls back to its sentences, and a reply with no
 * text at all gets one plain row.
 */

const ROWS_MAX = 6;
const HEADINGS_MAX = 3;
const ROW_CHARS = 90;
const TITLE_WORDS = 9;

export interface FallbackSection {
  heading: string;
  rows: string[];
}

/** Markdown noise out of one line: links keep their text, code and emphasis lose their marks. */
function plain(line: string): string {
  return cleanText(
    line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
      .replace(/<[^>]+>/g, "")
      .replace(/^>\s*/, ""),
    400,
  );
}

/** Headings and bullets of a reply, in order. Fenced code, Orca visual lines and Listen links are skipped. */
export function outline(reply: string): { headings: string[]; sections: FallbackSection[]; sentences: string[] } {
  const headings: string[] = [];
  const sections: FallbackSection[] = [{ heading: "", rows: [] }];
  const prose: string[] = [];
  let fence = false;
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line || /^::orca-visual/.test(line) || /^\[Listen\]/.test(line)) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const t = plain(h[1]!);
      if (t) {
        headings.push(t);
        sections.push({ heading: t, rows: [] });
      }
      continue;
    }
    const b = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (b) {
      const t = plain(b[1]!);
      if (t) sections[sections.length - 1]!.rows.push(t);
      continue;
    }
    if (/^\|/.test(line) || /^[-=_*]{3,}$/.test(line)) continue;
    const t = plain(line);
    if (t) prose.push(t);
  }
  const sentences = prose.join(" ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 2);
  return { headings, sections: sections.filter((s) => s.rows.length > 0 || s.heading), sentences };
}

const words = (t: string, n: number): string => t.split(/\s+/).slice(0, n).join(" ");

/** A headline of at most nine words, ending in a period, from the reply's first heading or sentence. */
function headline(headings: string[], sentences: string[]): string {
  const src = headings[0] ?? sentences[0] ?? "";
  const t = words(src.replace(/[.:!?\s]+$/, ""), TITLE_WORDS);
  return t ? `${t}.` : "What changed.";
}

/** The sections the card shows: at most three headings and six rows in all, each row cut at a word boundary. */
export function fallbackSections(reply: string): { title: string; sub: string; sections: FallbackSection[] } {
  const o = outline(reply);
  const title = headline(o.headings, o.sentences);
  const cut = (r: string): string => cleanWords(r, ROW_CHARS);
  let left = ROWS_MAX;
  let heads = 0;
  let out: FallbackSection[] = [];
  for (const s of o.sections) {
    if (left <= 0 || (s.heading && heads >= HEADINGS_MAX)) break;
    const rows = s.rows.slice(0, left).map(cut);
    if (rows.length === 0) continue; // a heading with no bullets under it adds nothing but the title
    if (s.heading) heads++;
    left -= rows.length;
    // The first heading is already the headline.
    out.push({ heading: s.heading && s.heading === o.headings[0] ? "" : cleanWords(s.heading, 50), rows });
  }
  // No bullets at all: the sentences stand in as the rows, skipping the one the headline came from.
  if (out.length === 0) {
    const skip = o.headings.length > 0 ? 0 : 1;
    const rows = o.sentences.slice(skip, skip + 4).map(cut);
    out = [{ heading: "", rows: rows.length > 0 ? rows : o.sentences.slice(0, 1).map(cut) }];
  }
  if (out.every((s) => s.rows.length === 0)) out = [{ heading: "", rows: ["The reply has no details to list."] }];
  const sub = o.headings.length > 0 && o.sentences[0] ? cleanWords(o.sentences[0], 140) : "";
  return { title, sub, sections: out };
}

const FALLBACK_CSS = `body.k-fallback{--bg:#f3f4ef;--eye:#3b4a3e}
.wc{padding:6px 16px 8px}
.wh{margin:12px 0 2px;font-size:14px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mute)}
.wc ul{list-style:none;margin:0;padding:0}
.wc li{display:flex;gap:12px;align-items:flex-start;padding:11px 0;font-size:18px;line-height:1.3;font-weight:600;border-top:1px solid var(--line)}
.wc li:first-child{border-top:0}
.wc li i{flex:none;width:11px;height:11px;margin-top:7px;border-radius:50%;background:var(--good)}`;

/** The finished page: eyebrow, headline, optional subhead and the list. Every value is escaped. */
export function renderFallbackHtml(reply: string): string {
  const { title, sub, sections } = fallbackSections(reply);
  const list = sections.map((s) => `${s.heading ? `<p class="wh">${e(s.heading)}</p>` : ""}<ul>${s.rows.map((r) => `<li><i></i><span>${e(r)}</span></li>`).join("")}</ul>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${CARDS_CSS}
${FALLBACK_CSS}
</style></head><body class="k-fallback"><main class="pg">
<p class="ey">EARSHOT <span>/</span> WHAT CHANGED</p><h1>${e(title)}</h1>${sub ? `<p class="sb">${e(sub)}</p>` : ""}
<section class="cd wc">${list}</section>
</main></body></html>
`;
}
