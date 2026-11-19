// Render assets/hero/hero.html to assets/hero.png (1280x640) and assets/hero@2x.png. macbook-only: Playwright.
// Usage: pnpm tsx scripts/render-hero.ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "assets");
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  for (const [scale, name] of [[1, "hero.png"], [2, "hero@2x.png"]] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(resolve(root, "hero", "hero.html")).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(root, name) });
    console.log(`wrote assets/${name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
