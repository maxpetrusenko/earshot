// Live run of the explain stage over test/fixtures/explain/*.json through the configured provider (claude-cli by default).
// Writes ~/earshot-demo/<out>[-2|-3].html (or <out>.NO_IMAGE.txt) and, with --shots, 390 and 1280 px PNGs per page
// to ~/earshot-demo/shots/. Prints each visual's type and visual-content density so a weak candidate is visible.
// Usage: pnpm tsx scripts/explain-demo.ts [--shots] [name ...]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildExplain } from "../src/explain.js";
import { visualDensity } from "../src/explain-gate.js";
import { createLlm } from "../src/llm.js";
import { redact } from "../src/redact.js";

const FIX = join(import.meta.dirname, "..", "test", "fixtures", "explain");
const OUT = join(homedir(), "earshot-demo");
const args = process.argv.slice(2);
const shots = args.includes("--shots");
const only = args.filter((a) => !a.startsWith("--"));

const cfg = loadConfig();
const llm = createLlm(cfg.llm);
mkdirSync(join(OUT, "shots"), { recursive: true });

interface Fixture {
  name: string;
  out: string;
  expect: "visual" | "no_image";
  reply: string;
}
const fixtures = readdirSync(FIX)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as Fixture)
  .filter((f) => only.length === 0 || only.includes(f.name));

const pages: { name: string; file: string; density: number }[] = [];
for (const f of fixtures) {
  const t = performance.now();
  const r = await buildExplain(llm, cfg.privacy.redact ? redact(f.reply).text : f.reply);
  const ms = Math.round(performance.now() - t);
  if (r.visuals.length > 0) {
    for (const [i, v] of r.visuals.entries()) {
      const file = join(OUT, `${f.out}${i === 0 ? "" : `-${i + 1}`}.html`);
      writeFileSync(file, v.html);
      const density = visualDensity(v.spec);
      pages.push({ name: f.name, file, density });
      console.log(`  visual ${i + 1}: ${v.spec.type.padEnd(14)} density ${density.toFixed(2)}  "${v.spec.title}"  -> ${file}`);
    }
  } else writeFileSync(join(OUT, `${f.out}.NO_IMAGE.txt`), `NO_IMAGE (${r.reason})\n`);
  const got = r.visuals.length > 0 ? "visual" : "no_image";
  console.log(`${got === f.expect ? "ok  " : "MISS"} ${f.name.padEnd(12)} want ${f.expect.padEnd(8)} got ${got.padEnd(8)} ${r.visuals.length} page(s) retries=${r.retries} ${ms}ms ${r.visuals.length === 0 ? (r.reason ?? "") : ""}`);
}

if (shots && pages.length) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const p of pages) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
        await page.goto(`file://${p.file}`);
        const path = join(OUT, "shots", `${p.name}-${width}-${p.file.split("/").pop()!.replace(/\.html$/, "")}.png`);
        await page.screenshot({ path, fullPage: true });
        console.log(`shot ${path}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
