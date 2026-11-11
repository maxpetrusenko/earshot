/**
 * Allowlist SVG sanitizer for renderer output that is derived from LLM text.
 * Drops script and foreignObject subtrees, unknown elements, every attribute not on the list,
 * external references, and CSS imports. Output is rebuilt from tokens, never passed through.
 */

const TAGS = new Set([
  "svg", "g", "defs", "marker", "polygon", "polyline", "path", "rect", "circle", "ellipse", "line",
  "text", "tspan", "style", "title", "desc",
]);

const ATTRS = new Set([
  "xmlns", "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "points", "d", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "stroke-opacity", "fill-opacity", "opacity", "transform", "class", "id", "style", "font-family",
  "font-size", "font-weight", "text-anchor", "dominant-baseline", "dx", "dy", "marker-start", "marker-end",
  "markerwidth", "markerheight", "refx", "refy", "orient", "markerunits", "preserveaspectratio",
]);

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function cleanCss(css: string): string {
  return css
    .replace(/\\[0-9a-fA-F]{1,6}\s?/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/image-set\s*\(/gi, "none(")
    .replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;{}]*;?/gi, "")
    .replace(/@import[^;{}]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/url\(\s*(?!["']?#)[^)]*\)/gi, "none");
}

function safeValue(name: string, value: string): string | null {
  const v = value.trim();
  if (/javascript:|data:|vbscript:/i.test(v)) return null;
  if (name === "style") return cleanCss(v);
  if (/url\(\s*(?!["']?#)/i.test(v)) return null;
  return v;
}

const esc = (s: string) => s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function sanitizeSvg(input: string): string {
  const src = input
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");
  let out = "";
  let inStyle = false;
  for (const tok of src.match(TOKEN) ?? []) {
    if (!tok.startsWith("<")) {
      out += inStyle ? cleanCss(tok) : tok.replace(/>/g, "&gt;");
      continue;
    }
    if (tok.startsWith("<!") || tok.startsWith("<?")) continue;
    const m = /^<(\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?)>$/.exec(tok);
    if (!m) continue;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!TAGS.has(name)) continue;
    if (name === "style") inStyle = !closing;
    if (closing) {
      out += `</${name}>`;
      continue;
    }
    let attrs = "";
    for (const a of m[3]!.matchAll(ATTR)) {
      const an = a[1]!;
      if (!ATTRS.has(an.toLowerCase()) && !/^data-[a-z0-9-]+$/i.test(an)) continue;
      const val = safeValue(an.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
      if (val !== null) attrs += ` ${an}="${esc(val)}"`;
    }
    out += `<${name === "svg" ? "svg" : name}${attrs}${m[4]}>`;
  }
  return out;
}
