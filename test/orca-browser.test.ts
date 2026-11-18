import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { fitOrcaPage } from "../src/orca.js";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const tone = (hz: number, seconds: number): Buffer =>
  spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, "-ac", "1", "-ar", "24000", "-b:a", "64k", "-f", "mp3", "pipe:1"], { maxBuffer: 1 << 24 }).stdout;

/** Elapsed seconds, read from the time label. */
const pos = (page: Page) => page.evaluate(() => {
  const m = /^(\d+):(\d+) \//.exec(document.getElementById("tm")!.textContent!)!;
  return Number(m[1]) * 60 + Number(m[2]);
});

const engines: [string, BrowserType][] = [["webkit", webkit], ["chromium", chromium]];

describe.skipIf(!haveFfmpeg).each(engines)("generated Orca page in headless %s", (_name, type) => {
  it("plays through Web Audio and every control works", async () => {
    const f = await fitOrcaPage(tone(440, 20), tone(660, 20), {});
    const dir = mkdtempSync(join(tmpdir(), "orca-br-"));
    const file = join(dir, "page.html");
    writeFileSync(file, f.html);
    const browser = await type.launch({ args: type === chromium ? ["--autoplay-policy=no-user-gesture-required"] : [] }).catch((e: Error) => {
      console.warn(`${_name} is not installed, skipping: ${e.message.split("\n")[0]}`);
      return null;
    });
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        (window as unknown as { __earshotGain: number }).__earshotGain = 0;
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        (window as unknown as { AudioContext: unknown }).AudioContext = function (...a: ConstructorParameters<typeof AudioContext>) {
          const c = new Ctx(...a);
          (window as unknown as { __ctx: AudioContext }).__ctx = c;
          return c;
        };
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`file://${file}`);
      await page.waitForFunction(() => document.getElementById("tm")!.textContent!.endsWith("/ 0:20"), null, { timeout: 15000 });
      expect(await page.textContent("#st")).toBe("");

      await page.click("#pp");
      expect(await page.textContent("#pp")).toBe("Pause");
      expect(await page.getAttribute("#pp", "class")).toBe("on");
      const ctx = () => page.evaluate(() => ({ state: (window as unknown as { __ctx: AudioContext }).__ctx.state, t: (window as unknown as { __ctx: AudioContext }).__ctx.currentTime }));
      await page.waitForFunction(() => (window as unknown as { __ctx: AudioContext }).__ctx.state === "running", null, { timeout: 15000 });
      const c0 = await ctx();
      expect(c0.state).toBe("running");
      await page.waitForFunction(() => (window as unknown as { __ctx: AudioContext }).__ctx.currentTime > 0.5, null, { timeout: 15000 });
      expect((await ctx()).t).toBeGreaterThan(c0.t);

      // 1x advance rate
      await page.waitForTimeout(1100);
      const a0 = await pos(page);
      await page.waitForTimeout(2000);
      const rate1 = ((await pos(page)) - a0) / 2;
      expect(rate1).toBeGreaterThan(0.5);
      expect(rate1).toBeLessThan(1.6);

      // pause holds the position and flips the label
      await page.click("#pp");
      expect(await page.textContent("#pp")).toBe("Play");
      expect(await page.getAttribute("#pp", "class")).toBe("");
      const held = await pos(page);
      await page.waitForTimeout(1200);
      expect(await pos(page)).toBe(held);

      // resume continues from the paused offset, not zero
      await page.click("#pp");
      await page.waitForTimeout(300);
      expect(await pos(page)).toBeGreaterThanOrEqual(held);

      // the removed controls are not in the page
      for (const id of ["sk", "bk", "fw", "sp"]) expect(await page.$(`#${id}`)).toBeNull();

      // space toggles when a non-button has focus
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press("Space");
      expect(await page.textContent("#pp")).toBe("Play");
      await page.keyboard.press("Space");
      expect(await page.textContent("#pp")).toBe("Pause");

      // the toggle switches track and keeps playing; Listen is selected first
      expect(await page.getAttribute("#be", "class")).toBe("sel");
      await page.click("#bo");
      expect(await page.getAttribute("#bo", "class")).toBe("sel");
      expect(await page.getAttribute("#be", "class")).toBe("");
      expect(await page.getAttribute("#bo", "aria-pressed")).toBe("true");
      expect(await page.textContent("#pp")).toBe("Pause");
      await page.click("#be");
      expect(await page.getAttribute("#be", "class")).toBe("sel");
      // paused: the toggle only selects
      await page.click("#pp");
      await page.click("#bo");
      expect(await page.textContent("#pp")).toBe("Play");
      expect(await page.getAttribute("#bo", "class")).toBe("sel");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});

describe.skipIf(!haveFfmpeg)("player page device handling in headless WebKit", () => {
  const load = async (opts: Parameters<Browser["newContext"]>[0], init?: () => void) => {
    const f = await fitOrcaPage(tone(440, 5), tone(660, 5));
    const dir = mkdtempSync(join(tmpdir(), "orca-ios-"));
    const file = join(dir, "player.html");
    writeFileSync(file, f.html);
    const browser = await webkit.launch().catch(() => null);
    if (!browser) return null;
    const ctx = await browser.newContext(opts);
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    await page.goto(`file://${file}`);
    return { page, browser, dir };
  };
  const height = (page: Page) => page.evaluate(() => Math.round(Math.max(document.documentElement.getBoundingClientRect().height, document.body.getBoundingClientRect().height, document.body.scrollHeight)));

  it("desktop: the player renders and works", async () => {
    const r = await load({});
    if (!r) return;
    try {
      expect(await r.page.evaluate(() => document.documentElement.className)).not.toBe("ios");
      await r.page.waitForFunction(() => document.getElementById("tm")!.textContent!.endsWith("/ 0:05"), null, { timeout: 15000 });
      expect(await r.page.isVisible("#pp")).toBe(true);
      expect(await height(r.page)).toBeGreaterThan(40);
    } finally {
      await r.browser.close();
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);

  it("iPhone profile: renders nothing and collapses to zero height", async () => {
    const r = await load({ ...devices["iPhone 13"] });
    if (!r) return;
    try {
      expect(await r.page.evaluate(() => navigator.userAgent)).toMatch(/iPhone/);
      expect(await r.page.evaluate(() => document.documentElement.className)).toBe("ios");
      expect(await r.page.isVisible("#pp")).toBe(false);
      expect(await height(r.page)).toBe(0);
      expect(await r.page.evaluate(() => document.getElementById("tm")!.textContent)).toBe("0:00 / 0:00"); // audio never decoded
    } finally {
      await r.browser.close();
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);

  it("iPad reporting a Mac user agent with touch points also collapses", async () => {
    const r = await load({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, () => {
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
    });
    if (!r) return;
    try {
      expect(await r.page.evaluate(() => document.documentElement.className)).toBe("ios");
      expect(await height(r.page)).toBe(0);
    } finally {
      await r.browser.close();
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});
