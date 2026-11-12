/** Optional PNG of the explain page, 1080x1350, through Playwright. Off by default; playwright is a dev dependency. */
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
    const page = await browser.newPage({ viewport: size });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: out, clip: { x: 0, y: 0, ...size } });
  } finally {
    await browser.close();
  }
  return out;
}
