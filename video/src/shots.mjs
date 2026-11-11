import { chromium } from "../../node_modules/playwright/index.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:7791/b/<briefId>"; // a served card, from `earshot serve`
const out = new URL("../assets/shots", import.meta.url).pathname;
const b = await chromium.launch({ channel: "chrome", args: ["--no-proxy-server"] });
for (const [w, h, name, dsf] of [[390, 844, "card-390", 2], [1080, 900, "card-1080", 1]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, colorScheme: "light" });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.evaluate(() => (document.querySelector("details").open = true));
  await p.screenshot({ path: `${out}/${name}-transcript.png`, fullPage: true });
  await ctx.close();
}
await b.close();
