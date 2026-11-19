import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderPendingHtml } from "../src/orca.js";

/**
 * Does Orca swap an `::orca-visual` page when its file changes on disk? Read from Orca's source (the host reads the file
 * once per mount, keeps it in a cache keyed by session and file name, and retries only a missing file at 1.5, 4 and
 * 10 s): it does not. This test uses Orca's own shell code to show the page-side workarounds cannot work either.
 */
const SHELL = "/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/native-chat/native-chat-visual-shell.js";
const have = existsSync(SHELL);

interface Shell {
  buildNativeChatVisualDocument: (a: { theme: { colorScheme: string; tokens: Record<string, string> }; channel: string; html: string }) => string;
}

describe.skipIf(!have)("Orca visual shell (real shell code)", () => {
  const shell = have ? (createRequire(import.meta.url)(SHELL) as Shell) : null;
  const doc = (html: string) => shell!.buildNativeChatVisualDocument({ theme: { colorScheme: "light", tokens: {} }, channel: "t", html });

  async function inFrame<T>(html: string, run: (frame: import("playwright").Frame, page: import("playwright").Page) => Promise<T>): Promise<T> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const srcdoc = doc(html).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      await page.setContent(`<iframe id="v" sandbox="allow-scripts" srcdoc="${srcdoc}" style="width:400px;height:200px"></iframe>`);
      const handle = await page.waitForSelector("#v");
      const frame = (await handle.contentFrame())!;
      return await run(frame, page);
    } finally {
      await browser.close();
    }
  }

  it("a page cannot fetch its own file: the shell's CSP has connect-src none", async () => {
    const html = `<body><p id="r">?</p><script>fetch("file:///tmp/x.html").then(function(){document.getElementById("r").textContent="fetched"},function(){document.getElementById("r").textContent="blocked"})</script></body>`;
    const text = await inFrame(html, async (f) => {
      await f.waitForFunction(() => document.getElementById("r")!.textContent !== "?");
      return f.locator("#r").textContent();
    });
    expect(text).toBe("blocked");
  }, 30000);

  it("a self-reloading stand-in never turns into the new page: reload re-renders the same srcdoc", async () => {
    const standIn = renderPendingHtml("player", { reload: true, madeAt: Date.now() });
    const still = await inFrame(standIn, async (f, page) => {
      await page.waitForTimeout(3500); // more than two reload ticks of 1.5 s
      return f.locator("#st").textContent();
    });
    expect(still).toContain("Preparing audio");
  }, 30000);
});
