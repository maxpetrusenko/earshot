import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainPng } from "../src/explain-png.js";

const dims = (f: string): { w: number; h: number } => {
  const b = readFileSync(f);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const page = (blocks: number): string => `<!doctype html><body style="margin:0;background:#f3f4ef"><main style="padding:24px">${Array.from({ length: blocks }, () => `<div style="height:100px;margin:0 0 12px;background:#fff"></div>`).join("")}</main></body>`;

describe("explain PNG", () => {
  it("is at least 1080 px wide at 2x and its height follows the content, not a fixed canvas", async () => {
    const d = mkdtempSync(join(tmpdir(), "earshot-png-"));
    try {
      const short = await explainPng(page(2), join(d, "s.png"));
      const tall = await explainPng(page(14), join(d, "t.png"));
      const s = dims(short);
      const t = dims(tall);
      expect(s.w).toBe(2160);
      expect(t.w).toBe(2160);
      expect(s.h).toBeLessThan(1000); // far under the old 2700
      expect(t.h).toBeGreaterThan(s.h * 3);
      expect(s.h).toBeGreaterThan((24 * 2 + 2 * 112) * 2 - 10); // all the content is in, nothing cut
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60000);
});
