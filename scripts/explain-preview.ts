import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseExplainAll } from "../src/explain-schema.js";
import { explainGate, visualDensity } from "../src/explain-gate.js";
import { renderExplainHtml } from "../src/explain-render.js";

// Render a hand-authored or saved model answer (one visual or {"visuals":[...]}) without an LLM.
// Usage: pnpm tsx scripts/explain-preview.ts <spec.json> [out.html] [--shots]
const [file, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const shots = process.argv.includes("--shots");
if (!file) {
  console.error("usage: explain-preview <spec.json> [out.html] [--shots]");
  process.exit(2);
}
const specs = parseExplainAll(JSON.parse(readFileSync(resolve(file), "utf8")));
const base = outArg ?? join(dirname(resolve(file)), basename(file).replace(/\.json$/, ""));
mkdirSync(dirname(resolve(base)), { recursive: true });
const pages: string[] = [];
specs.forEach((spec, i) => {
  const bad = explainGate(spec);
  // Same page names the CLI writes: explain.html, explain2.html, explain3.html.
  const stem = base.endsWith("explain") ? (i === 0 ? base : `${base}${i + 1}`) : `${base}${i === 0 ? "" : `-${i + 1}`}`;
  const out = `${stem}.html`;
  writeFileSync(out, renderExplainHtml(spec));
  pages.push(out);
  console.log(`${i + 1}. ${spec.type} density ${visualDensity(spec).toFixed(2)} gate ${bad ?? "pass"} -> ${out}`);
});
if (shots && pages.length) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const p of pages) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
        await page.goto(pathToFileURL(resolve(p)).href);
        const shot = `${p.replace(/\.html$/, "")}-${width}.png`;
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`shot ${shot}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
