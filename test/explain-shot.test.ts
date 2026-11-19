import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureShotPage, outlineLabel, pageResponds } from "../src/explain-shot.js";

const PAGE = `<!doctype html><title>Invoices</title><body style="font-family:sans-serif"><main><h1>Invoices</h1><button id="b" style="padding:12px 20px;font-size:18px">Export</button></main></body>`;
let server: ReturnType<typeof createServer>;
let url: string;
beforeAll(async () => {
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invoices`;
});
afterAll(() => server.close());

describe("real screenshot for a UI change", () => {
  it("takes the quoted label for the one outline", () => {
    expect(outlineLabel('The "Export" button is now in the toolbar.')).toBe("Export");
    expect(outlineLabel("nothing quoted")).toBeNull();
  });
  it("HEAD answers within the limit; a closed port does not", async () => {
    expect(await pageResponds(url)).toBe(true);
    expect(await pageResponds("http://127.0.0.1:9/")).toBe(false);
    expect(await pageResponds("file:///etc/hosts")).toBe(false);
  });
  it("captures the page into a small data: JPEG card, and falls back to null with no URL or a dead one", async () => {
    const logs: string[] = [];
    const html = await captureShotPage(`# Export button moved\n\nThe "Export" button is now in the toolbar at ${url}.`, (l) => logs.push(l));
    expect(html).not.toBeNull();
    expect(html).toContain("data:image/jpeg;base64,");
    expect(html!.length).toBeLessThan(420_000);
    expect(html).toContain("EARSHOT");
    expect(await captureShotPage("The toolbar changed. No page named.", () => undefined)).toBeNull();
    expect(await captureShotPage("See http://127.0.0.1:9/ for it.", (l) => logs.push(l))).toBeNull();
    expect(logs.join("\n")).toContain("did not answer HEAD");
  }, 60000);
});
