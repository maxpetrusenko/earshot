/**
 * One page that shows several explain pages one under the other, for `--visual`: the chat gets a single Explain line
 * (the number of visuals is only known after the model answers), so that one page carries every visual.
 *
 * The pages cannot go in iframes (Orca's visual CSP has `frame-src 'none'`), so each page's body is inlined and its
 * CSS is scoped under its own wrapper class. `html`, `body` and `:root` rules move onto the wrapper, so each visual
 * keeps its own background and theme variables, and nothing leaks between them. SVG ids get a per-page prefix so
 * markers do not collide.
 */

const STACK_CSS = `html,body{margin:0;padding:0}
.vz{display:flow-root}`;

/** Prefix one selector with the scope. `html`, `body` and `:root` become the scope itself. */
function scopeSelector(sel: string, scope: string): string {
  const s = sel.trim();
  if (!s) return s;
  const root = /^(?:html|body|:root)(?![A-Za-z0-9_-])/.exec(s);
  if (root) return scope + s.slice(root[0].length);
  return `${scope} ${s}`;
}

/** Split on commas that are not inside parentheses or brackets. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Scope every rule of a stylesheet. Handles plain rules and one level of `@media`; the CSS here is our own. */
export function scopeCss(css: string, scope: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    if (prelude.startsWith("@media") || prelude.startsWith("@supports")) out += `${prelude}{${scopeCss(inner, scope)}}\n`;
    else if (prelude.startsWith("@")) out += `${prelude}{${inner}}\n`;
    else out += `${splitSelectors(prelude).map((x) => scopeSelector(x, scope)).join(",")}{${inner}}\n`;
    i = j;
  }
  return out;
}

const between = (html: string, open: RegExp, close: string): string | null => {
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf(close, start);
  return end < 0 ? null : html.slice(start, end);
};

/** Give every id in a body fragment a prefix, and the references to it. */
function prefixIds(body: string, prefix: string): string {
  return body
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/\bhref="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`);
}

/**
 * The pages as one document. Zero pages is an error (the caller guarantees at least one), one page is returned as
 * it is, and two or more are stacked in order.
 */
export function stackPages(pages: string[]): string {
  if (pages.length === 0) throw new Error("stackPages needs at least one page");
  if (pages.length === 1) return pages[0]!;
  const styles: string[] = [];
  const blocks: string[] = [];
  pages.forEach((html, i) => {
    const scope = `.vz${i + 1}`;
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
    const bodyTag = /<body([^>]*)>/.exec(html);
    const cls = /class="([^"]*)"/.exec(bodyTag?.[1] ?? "")?.[1] ?? "";
    const inner = between(html, /<body[^>]*>/, "</body>") ?? "";
    styles.push(scopeCss(css, scope));
    blocks.push(`<div class="vz vz${i + 1}${cls ? ` ${cls}` : ""}">${prefixIds(inner, `vz${i + 1}-`)}</div>`);
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${STACK_CSS}
${styles.join("\n")}
</style></head><body>
${blocks.join("\n")}
</body></html>
`;
}
