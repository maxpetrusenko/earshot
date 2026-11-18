import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { renderExplainHtml } from "../src/explain-render.js";
import { renderFallbackHtml } from "../src/explain-fallback.js";
import { scopeCss, stackPages } from "../src/explain-stack.js";
import { parseExplain } from "../src/explain-schema.js";
import { EXPLAIN_SPEC } from "./explain-fixtures.js";

const spec = parseExplain(EXPLAIN_SPEC)!;
const pageA = renderExplainHtml(spec);
const pageB = renderFallbackHtml("# Second change\n\n- First row\n- Second row\n");

describe("scopeCss", () => {
  it("moves html, body and :root onto the scope and prefixes the rest", () => {
    const out = scopeCss("*{box-sizing:border-box}:root{--a:1}html{background:red}body.k-x{--b:2}body{margin:0}h1,.a>b{c:d}", ".vz1");
    expect(out).toContain(".vz1 *{box-sizing:border-box}");
    expect(out).toContain(".vz1{--a:1}");
    expect(out).toContain(".vz1{background:red}");
    expect(out).toContain(".vz1.k-x{--b:2}");
    expect(out).toContain(".vz1{margin:0}");
    expect(out).toContain(".vz1 h1,.vz1 .a>b{c:d}");
  });
  it("scopes inside @media and keeps the query", () => {
    expect(scopeCss("@media(min-width:760px){.pg{max-width:620px}h1{font-size:42px}}", ".vz2")).toBe("@media(min-width:760px){.vz2 .pg{max-width:620px}\n.vz2 h1{font-size:42px}\n}\n");
  });
  it("does not split a selector on a comma inside :not()", () => {
    expect(scopeCss("a:not(.x,.y){k:v}", ".vz1")).toContain(".vz1 a:not(.x,.y){k:v}");
  });
});

describe("stackPages", () => {
  it("returns a single page unchanged and rejects none", () => {
    expect(stackPages([pageA])).toBe(pageA);
    expect(() => stackPages([])).toThrow();
  });
  it("puts every page in its own scoped block, in order, with the body class kept", () => {
    const html = stackPages([pageA, pageB]);
    expect(html.indexOf("Retries now stop at five")).toBeLessThan(html.indexOf("Second change"));
    expect(html).toContain('<div class="vz vz1">');
    expect(html).toContain('<div class="vz vz2 k-fallback">');
    expect((html.match(/<main/g) ?? []).length).toBe(2);
    expect(html.match(/<body/g)).toHaveLength(1);
    expect(html).not.toMatch(/100\s*vh/);
    // every rule in the style block is scoped or is the shared preamble
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/^(?:h1|\.pg|\.ex|\.ey)[^{]*\{/m);
  });
  it("prefixes svg ids and their references so pages do not collide", () => {
    const svg = `<body><svg><defs><marker id="a0"/></defs><line marker-end="url(#a0)"/></svg></body>`;
    const html = stackPages([`<style></style>${svg}`, `<style></style>${svg}`]);
    expect(html).toContain('id="vz1-a0"');
    expect(html).toContain("url(#vz2-a0)");
  });
});

describe("stacked page in a browser", () => {
  it("lays the visuals out one under the other and each keeps its own styling", async () => {
    const browser = await chromium.launch().catch(() => null);
    if (!browser) return;
    try {
      const probe = async (html: string, sel: string) => {
        const p = await browser.newPage({ viewport: { width: 520, height: 700 } });
        await p.setContent(html);
        const r = await p.evaluate((s) => {
          const el = document.querySelector(s)!;
          const cs = getComputedStyle(el);
          return { size: cs.fontSize, family: cs.fontFamily, h: document.documentElement.getBoundingClientRect().height };
        }, sel);
        await p.close();
        return r;
      };
      const aloneA = await probe(pageA, "h1");
      const aloneB = await probe(pageB, "h1");
      const stacked = stackPages([pageA, pageB]);
      const p = await browser.newPage({ viewport: { width: 520, height: 700 } });
      await p.setContent(stacked);
      const got = await p.evaluate(() => {
        const [a, b] = Array.from(document.querySelectorAll<HTMLElement>(".vz"));
        const ra = a!.getBoundingClientRect();
        const rb = b!.getBoundingClientRect();
        const h = (el: HTMLElement) => { const x = getComputedStyle(el.querySelector("h1")!); return { size: x.fontSize, family: x.fontFamily }; };
        return { aBottom: ra.bottom, bTop: rb.top, aH: ra.height, bH: rb.height, doc: document.documentElement.getBoundingClientRect().height, ha: h(a!), hb: h(b!), bodyMargin: getComputedStyle(document.body).margin };
      });
      await p.close();
      expect(got.aH).toBeGreaterThan(100);
      expect(got.bH).toBeGreaterThan(100);
      expect(got.bTop).toBeGreaterThanOrEqual(got.aBottom - 0.5);
      expect(got.doc).toBeGreaterThanOrEqual(got.aH + got.bH - 1);
      expect(got.ha).toEqual({ size: aloneA.size, family: aloneA.family });
      expect(got.hb).toEqual({ size: aloneB.size, family: aloneB.family });
      expect(got.bodyMargin).toBe("0px");
    } finally {
      await browser.close();
    }
  }, 60000);
});
