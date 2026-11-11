import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit } from "playwright";
import { describe, expect, it } from "vitest";
import { fitOrcaPage } from "../src/orca.js";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const haveWebkit = existsSync(webkit.executablePath());

const tone = (hz: number, seconds: number): Buffer =>
  spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, "-ac", "1", "-ar", "24000", "-b:a", "64k", "-f", "mp3", "pipe:1"], { maxBuffer: 1 << 24 }).stdout;

describe.skipIf(!haveFfmpeg || !haveWebkit)("generated page in headless WebKit", () => {
  it("loads both tracks, plays, toggles, and Original pauses the edited track", async () => {
    const f = await fitOrcaPage(tone(440, 6), tone(660, 6));
    const dir = mkdtempSync(join(tmpdir(), "orca-wk-"));
    const file = join(dir, "page.html");
    writeFileSync(file, f.html);
    const browser = await webkit.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`file://${file}`);
      await page.evaluate(() => document.querySelectorAll("audio").forEach((a) => ((a as HTMLAudioElement).muted = true)));
      await page.waitForFunction(() => [...document.querySelectorAll("audio")].every((a) => (a as HTMLAudioElement).readyState >= 1 && (a as HTMLAudioElement).duration > 0), null, { timeout: 15000 });
      const info = await page.evaluate(() => [...document.querySelectorAll("audio")].map((a) => ({ rs: (a as HTMLAudioElement).readyState, d: (a as HTMLAudioElement).duration })));
      console.log("webkit audio elements", JSON.stringify(info));
      expect(info).toHaveLength(2);
      for (const a of info) {
        expect(a.rs).toBeGreaterThanOrEqual(1);
        expect(a.d).toBeGreaterThan(0);
      }
      await page.click("#be");
      await page.waitForFunction(() => (document.getElementById("ae") as HTMLAudioElement).currentTime > 0.2, null, { timeout: 15000 });
      expect(await page.textContent("#be")).toBe("Pause");
      await page.click("#bo");
      expect(await page.evaluate(() => (document.getElementById("ae") as HTMLAudioElement).paused)).toBe(true);
      expect(await page.textContent("#be")).toBe("Play");
      await page.waitForFunction(() => (document.getElementById("ao") as HTMLAudioElement).currentTime > 0.2, null, { timeout: 15000 });
      expect(await page.textContent("#bo")).toBe("Pause");
      await page.click("#bo");
      expect(await page.evaluate(() => (document.getElementById("ao") as HTMLAudioElement).paused)).toBe(true);
      console.log("webkit play/pause/original OK, page bytes", f.bytes, "kbps", f.kbps, readFileSync(file).length);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
