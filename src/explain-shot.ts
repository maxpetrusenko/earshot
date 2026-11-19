import { CARDS_CSS } from "./explain-cards-css.js";
import { fallbackSections } from "./explain-fallback.js";
import { escapeHtml as e } from "./orca.js";
import { findPageUrl } from "./situation.js";

/**
 * UI change with a real page: when the reply names a URL or a localhost page and it answers a HEAD within 2 s, the
 * detached worker takes a real screenshot with Playwright, outlines one element, and shows that instead of a drawing.
 * Any miss (no URL, no answer, no Playwright or Chromium, page too big) returns null and the drawn version is used.
 * The page embeds the picture as a data: JPEG, which Orca's visual CSP allows (img-src data:).
 */

export const HEAD_TIMEOUT_MS = 2000;
const WIDTH = 390;
const MAX_HEIGHT = 1400;
/** Orca reads visuals up to 512 KB; keep the whole page well under it. */
const MAX_BYTES = 420_000;

/** A page that answers HEAD in time. Only http and https are ever contacted. */
export async function pageResponds(url: string, timeoutMs = HEAD_TIMEOUT_MS): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 400;
  } catch {
    return false;
  }
}

/** The label the reply puts in quotes (a button, a tab), the one thing to outline. */
export function outlineLabel(reply: string): string | null {
  const m = /["“]([^"”\n]{2,24})["”]/.exec(reply);
  return m ? m[1]!.trim() : null;
}

export function shotPageHtml(reply: string, url: string, jpeg: Buffer): string {
  const { title } = fallbackSections(reply);
  const host = new URL(url).host;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${CARDS_CSS}
body.k-shot{--bg:#f3f4ef;--eye:#3b4a3e}
.sh{display:block;width:100%;height:auto;border-radius:12px}
.shc{padding:8px;margin:0 0 12px;overflow:hidden}
</style></head><body class="k-shot"><main class="pg">
<p class="ey">EARSHOT <span>/</span> LIVE PAGE</p><h1>${e(title)}</h1>
<section class="cd shc"><img class="sh" alt="Screenshot of ${e(host)} with the changed element outlined" src="data:image/jpeg;base64,${jpeg.toString("base64")}"></section>
<p class="ft"><i></i>${e(host)}</p>
</main></body></html>
`;
}

/** The screenshot page for a reply, or null when the drawn version should be used. */
export async function captureShotPage(reply: string, log: (l: string) => void): Promise<string | null> {
  const url = findPageUrl(reply);
  if (!url) return null;
  if (!(await pageResponds(url))) {
    log(`shot: ${url} did not answer HEAD within ${HEAD_TIMEOUT_MS} ms; drawing instead`);
    return null;
  }
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const tab = await browser.newPage({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 2 });
      await tab.goto(url, { timeout: 8000, waitUntil: "load" });
      const label = outlineLabel(reply);
      const target = label ? tab.getByText(label, { exact: false }).first() : tab.locator("main, [role=main], body > *").first();
      if ((await target.count()) > 0) await target.evaluate((el) => ((el as HTMLElement).style.cssText += ";outline:4px solid #1b4f9f;outline-offset:3px;border-radius:6px"));
      for (const quality of [72, 55, 40]) {
        const jpeg = await tab.screenshot({ type: "jpeg", quality, ...(await clipFor(tab)), fullPage: true });
        const html = shotPageHtml(reply, url, jpeg);
        if (html.length <= MAX_BYTES) return html;
      }
      log("shot: the screenshot does not fit Orca's page size; drawing instead");
      return null;
    } finally {
      await browser.close();
    }
  } catch (err) {
    log(`shot: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}; drawing instead`);
    return null;
  }
}

/** Page height capped so a long page is cropped to its top, not shrunk to nothing. */
async function clipFor(tab: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<{ clip: { x: number; y: number; width: number; height: number } }> {
  const h = await tab.evaluate(() => document.documentElement.scrollHeight);
  return { clip: { x: 0, y: 0, width: WIDTH, height: Math.min(h, MAX_HEIGHT) } };
}
