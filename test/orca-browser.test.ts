import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { fitOrcaPage } from "../src/orca.js";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const tone = (hz: number, seconds: number): Buffer =>
  spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, "-ac", "1", "-ar", "24000", "-b:a", "64k", "-f", "mp3", "pipe:1"], { maxBuffer: 1 << 24 }).stdout;

const SVG = '<svg viewBox="0 0 100 40"><rect x="2" y="2" width="30" height="20" fill="#1f6f5c"/><text x="40" y="20">ok</text></svg>';

/** Seek position in seconds, read from the progress bar (1000 steps over the track). */
const pos = (page: Page) => page.evaluate(() => (Number((document.getElementById("sk") as HTMLInputElement).value) / 1000) * 20);

const engines: [string, BrowserType][] = [["webkit", webkit], ["chromium", chromium]];

describe.skipIf(!haveFfmpeg).each(engines)("generated Orca page in headless %s", (_name, type) => {
  it("plays through Web Audio and every control works", async () => {
    const f = await fitOrcaPage(tone(440, 20), tone(660, 20), { title: "Fixed the retries", svg: SVG });
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

      await page.click("#be");
      expect(await page.textContent("#be")).toBe("Pause");
      expect(await page.getAttribute("#be", "class")).toBe("on");
      const ctx = () => page.evaluate(() => ({ state: (window as unknown as { __ctx: AudioContext }).__ctx.state, t: (window as unknown as { __ctx: AudioContext }).__ctx.currentTime }));
      await page.waitForFunction(() => (window as unknown as { __ctx: AudioContext }).__ctx.state === "running", null, { timeout: 15000 });
      const c0 = await ctx();
      expect(c0.state).toBe("running");
      await page.waitForFunction(() => (window as unknown as { __ctx: AudioContext }).__ctx.currentTime > 0.5, null, { timeout: 15000 });
      expect((await ctx()).t).toBeGreaterThan(c0.t);

      // 1x advance rate
      const a0 = await pos(page);
      await page.waitForTimeout(1000);
      const rate1 = (await pos(page)) - a0;
      expect(rate1).toBeGreaterThan(0.6);
      expect(rate1).toBeLessThan(1.5);

      // pause holds the position and flips the label
      await page.click("#be");
      expect(await page.textContent("#be")).toBe("Play");
      expect(await page.getAttribute("#be", "class")).toBe("sel");
      const held = await pos(page);
      await page.waitForTimeout(500);
      expect(Math.abs((await pos(page)) - held)).toBeLessThan(0.1);

      // resume continues from the paused offset, not zero
      await page.click("#be");
      await page.waitForTimeout(300);
      expect(await pos(page)).toBeGreaterThanOrEqual(held - 0.1);

      // forward and back 10 s
      const before = await pos(page);
      await page.click("#fw");
      expect((await pos(page)) - before).toBeGreaterThan(9);
      await page.click("#bk");
      expect(Math.abs((await pos(page)) - before)).toBeLessThan(1.5);

      // seek by the progress bar jumps and keeps playing
      await page.evaluate(() => {
        const s = document.getElementById("sk") as HTMLInputElement;
        s.value = "750";
        s.dispatchEvent(new Event("input"));
        s.dispatchEvent(new Event("change"));
      });
      await page.waitForTimeout(200);
      expect(await pos(page)).toBeGreaterThan(14.8);
      expect(await page.textContent("#be")).toBe("Pause");

      // speed cycles 1x, 1.25x, 1.5x, 2x and changes the advance rate
      await page.evaluate(() => {
        const s = document.getElementById("sk") as HTMLInputElement;
        s.value = "100";
        s.dispatchEvent(new Event("change"));
      });
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        await page.click("#sp");
        seen.push((await page.textContent("#sp"))!);
      }
      expect(seen).toEqual(["1.25x", "1.5x", "2x"]);
      const b0 = await pos(page);
      await page.waitForTimeout(1000);
      const rate2 = (await pos(page)) - b0;
      expect(rate2 / rate1).toBeGreaterThan(1.5);
      expect(rate2 / rate1).toBeLessThan(2.6);
      await page.click("#sp");
      expect(await page.textContent("#sp")).toBe("1x");

      // space toggles when a non-button has focus
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press("Space");
      expect(await page.textContent("#be")).toBe("Play");
      await page.keyboard.press("Space");
      expect(await page.textContent("#be")).toBe("Pause");

      // Original switches track: the edited button stops being active
      await page.click("#bo");
      expect(await page.textContent("#bo")).toBe("Pause");
      expect(await page.textContent("#be")).toBe("Play");
      expect(await page.getAttribute("#bo", "class")).toBe("on");
      await page.click("#bo");
      expect(await page.textContent("#bo")).toBe("Original");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
