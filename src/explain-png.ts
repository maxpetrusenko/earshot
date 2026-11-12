/** Optional PNG of the explain page, 1080 px wide, through Playwright. Off by default; playwright is a dev dependency. */
export const PNG_SIZE = { width: 1080, height: 1350 };

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
    // fullPage so a dense page is never cut at the viewport height.
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await browser.close();
  }
  return out;
}
