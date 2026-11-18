// Capture and annotate: a tight Playwright element screenshot of a REAL page, with one outline. Never redraw the app.
// Usage: pnpm tsx scripts/explain-capture.ts <page.html|url> <selector> <out.png> [--outline <selector>] [--pad 12] [--width 390]
// For a state change, run it once per state (load the page in each state, or pass a url with the state in it)
// and show the two crops one above the other in the same slot.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flagIdx = new Set(["--outline", "--pad", "--width"].flatMap((f) => (args.includes(f) ? [args.indexOf(f), args.indexOf(f) + 1] : [])));
const [page, selector, out] = args.filter((_, i) => !flagIdx.has(i));
if (!page || !selector || !out) {
  console.error("usage: explain-capture <page.html|url> <selector> <out.png> [--outline <selector>] [--pad 12] [--width 390]");
  process.exit(2);
}
const pad = Number(flag("--pad") ?? 12);
const width = Number(flag("--width") ?? 390);
const outline = flag("--outline");
const url = /^https?:|^file:/.test(page) ? page : pathToFileURL(resolve(page)).href;

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
  await tab.goto(url);
  if (outline) await tab.addStyleTag({ content: `${outline}{outline:4px solid #b45309!important;outline-offset:3px!important;border-radius:6px}` });
  const box = await tab.locator(selector).first().boundingBox();
  if (!box) throw new Error(`selector not found: ${selector}`);
  await tab.screenshot({ path: resolve(out), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 }, fullPage: true });
  console.log(`captured ${selector} -> ${resolve(out)}`);
} finally {
  await browser.close();
}
