/**
 * Optional PNG of the explain page, 1080 px wide at 2x, through Playwright. Off by default; playwright is a dev dependency.
 * The height follows the content: the viewport starts short and the shot is cropped to the bottom of the page's content
 * plus padding, so a short chart is not left on top of a blank 1350 px canvas (these PNGs go out as chat photos).
 */
export const PNG_SIZE = { width: 1080, height: 200 };
/** Space kept under the last piece of content, in CSS px. */
export const PNG_PAD = 40;

export async function explainPng(html: string, out: string, size: { width: number; height: number } = PNG_SIZE): Promise<string> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("--explain-png needs playwright (pnpm add -D playwright, then npx playwright install chromium)");
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });
    const bottom = await page.evaluate(() => Math.max(0, ...Array.from(document.body.children).map((c) => c.getBoundingClientRect().bottom + window.scrollY)));
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.max(1, Math.ceil(Math.min(bottom + PNG_PAD, full)));
    await page.screenshot({ path: out, fullPage: true, clip: { x: 0, y: 0, width: size.width, height } });
  } finally {
    await browser.close();
  }
  return out;
}
