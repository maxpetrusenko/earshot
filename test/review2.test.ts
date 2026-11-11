import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir } from "../src/bundle.js";
import { parseConfig } from "../src/config.js";
import { checkScript, checkTitle, generateEarScript, looksRandom, validEvidence } from "../src/earscript.js";
import { prepareBrief } from "../src/prepare.js";
import { extractStdin, readAll } from "../src/extract/stdin.js";
import { createLlm } from "../src/llm.js";
import { redact } from "../src/redact.js";
import { runPipeline } from "../src/run.js";
import { createEarshotServer } from "../src/serve.js";
import { startFakeProvider } from "./helpers.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-r2-"));
  process.env.EARSHOT_HOME = home;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("evidence host allowlist", () => {
  const ok = (u: string, hosts: string[] = []) => validEvidence(u, `see ${u} done`, hosts);
  it("accepts github and gitlab links, including commit ids and branch names", () => {
    expect(ok("https://github.com/acme/app/pull/42")).not.toBeNull();
    expect(ok("https://gitlab.com/acme/app/-/merge_requests/9")).not.toBeNull();
    expect(ok("https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567")).not.toBeNull();
    expect(ok("https://github.com/acme/app/tree/fix-webhook-retries-stop-at-five")).not.toBeNull();
  });
  it("rejects hosts that are not allowlisted, unless configured", () => {
    expect(ok("https://example.org/report/1")).toBeNull();
    expect(ok("https://ci.example.org/run/7", ["example.org"])).not.toBeNull();
    expect(ok("https://evilgithub.com/a/b")).toBeNull();
    expect(ok("https://github.com.evil.test/a/b")).toBeNull();
  });
  it("never lets a Slack or Discord webhook become evidence", () => {
    expect(ok("https://hooks.slack.com/" + "services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX", ["slack.com"])).toBeNull();
    expect(ok("https://discord.com/api/webhooks/123456789012345678/abcDEF_ghiJKL-mnoPQR0123456789xyzABCDEFGH", ["discord.com"])).toBeNull();
  });
  it("rejects a long random-looking path segment even on an allowed host", () => {
    expect(ok("https://github.com/acme/app/blob/main/aB3dE9fG7hJ2kL5mN8pQ1rS4tU6vW0xY")).toBeNull();
    expect(looksRandom("aB3dE9fG7hJ2kL5mN8pQ1rS4tU6vW0xY")).toBe(true);
    expect(looksRandom("fix-webhook-retries-stop-at-five")).toBe(false);
    expect(looksRandom("short1")).toBe(false);
  });
});

describe("redact additions", () => {
  const scrubbed = (s: string, needle: string) => {
    const r = redact(s);
    expect(r.text, s).not.toContain(needle);
    expect(r.count).toBeGreaterThan(0);
  };
  it.each([
    ["sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqLyjWDarjtT1zdp7dc"],
    ["sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqLyjWDarjtT1zdp7dc"],
    ["rk_" + "live_4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqLyjWDarjtT1zdp7dc"],
    ["glpat-abcdefghij0123456789", "abcdefghij0123456789"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AIzaSyA-abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"],
    ["hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH", "abcdefghijklmnopqrstuvwxyzABCDEFGH"],
    ["xoxb-1234567890-abcdefghijklm", "abcdefghijklm"],
    ["xoxp-1234567890-abcdefghijklm", "abcdefghijklm"],
    ["see https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop", "abcdefghijklmnop"],
    ["post to https://discord.com/api/webhooks/123456789012345678/abcDEFghiJKLmno", "abcDEFghiJKLmno"],
    ["DB_PASS=hunter22secret", "hunter22secret"],
    ["passphrase: correcthorsebattery", "correcthorse"],
    ["Cookie: sessionid=abc123def456; theme=dark", "abc123def456"],
    ["Set-Cookie: sid=zzz999yyy888; Path=/; HttpOnly", "zzz999yyy888"],
    ["https://b.s3.amazonaws.com/o?X-Amz-Signature=deadbeef01234567&X-Amz-Credential=AKIDEXAMPLE%2F2026", "deadbeef01234567"],
    ["key 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318 here", "4c0883a69102937d6231471b5dbb6204"],
  ])("scrubs %s", (s, needle) => scrubbed(s, needle));
  it("keeps ordinary prose", () => {
    const prose = "We bypass the cache and the compass points north. Tests passed: 12.";
    expect(redact(prose).text).toBe(prose);
  });
  it("scrubs 400k chars of a.a.a. in under 200ms", () => {
    const text = "a.a.a.".repeat(Math.ceil(400_000 / 6));
    const t0 = performance.now();
    redact(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("stays linear on other repeating shapes", () => {
    for (const u of ["a-a-a-", "a_a_a_", "a://a://", "password", "a=a=a=", "Cookie:"]) {
      const t0 = performance.now();
      redact(u.repeat(Math.ceil(400_000 / u.length)));
      expect(performance.now() - t0, u).toBeLessThan(500);
    }
  });
});

describe("title leak check", () => {
  it("flags paths, urls and identifiers in a title", () => {
    expect(checkTitle("Fixed src/billing/webhook.ts")).toMatch(/title contains/);
    expect(checkTitle("See https://x.test")).toMatch(/URL/);
    expect(checkTitle("Webhook retries now stop at five")).toBeNull();
  });
  it("replaces a leaking --title in the bundle", async () => {
    const p = await startFakeProvider();
    try {
      const cfg = parseConfig(`llm:\n  type: openai-compatible\n  base_url: ${p.url}\n  model: fake\ntts:\n  base_url: ${p.url}\n`);
      const r = await runPipeline(cfg, createLlm(cfg.llm), "x ".repeat(300), { from: "stdin", title: "Edited ./src/secret/path.ts" });
      expect(r.meta.title).toBe("Task finished");
    } finally {
      p.server.close();
    }
  });
});

describe("stdin cap keeps the conclusion", () => {
  it("bounds memory but keeps a unique marker on the last line of a 1MB input", async () => {
    const line = "step output line that is not interesting\n";
    const body = line.repeat(Math.ceil(1_000_000 / line.length)) + "FINAL-CONCLUSION-MARKER-7Q\n";
    const chunks = Readable.from(Buffer.from(body).toString("latin1").match(/[\s\S]{1,65536}/g)!.map((c) => Buffer.from(c, "latin1")));
    const r = await extractStdin(chunks, 40000);
    expect(r.text).toContain("FINAL-CONCLUSION-MARKER-7Q");
    expect(r.text.length).toBeLessThanOrEqual(40100);
    expect(r.truncated).toBe(true);
    const cfg = parseConfig("llm:\n  type: openai-compatible\n  base_url: http://x/v1\n  model: m\n");
    const prep = prepareBrief(cfg, r.text, { from: "stdin" });
    expect(readFileSync(join(prep.dir, "input.txt"), "utf8")).toContain("FINAL-CONCLUSION-MARKER-7Q");
  });
  it("keeps head and tail of a stream larger than the byte cap", async () => {
    const s = Readable.from([Buffer.from("HEAD" + "a".repeat(1000)), Buffer.from("b".repeat(5000)), Buffer.from("c".repeat(1000) + "TAIL")]);
    const out = await readAll(s, 1000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("[...]");
  });
});

describe("digits in scripts", () => {
  const words = Array.from({ length: 100 }, () => "word").join(" ");
  it("names the offending tokens", () => {
    expect(checkScript(`${words} PG16 and 14.11 and 429.`)).toBe("spell these out for speech: PG16, 14.11, 429");
    expect(checkScript(words)).toBeNull();
  });
  it("retries once with feedback, then accepts with a warning", async () => {
    const seen: string[] = [];
    const llm = {
      name: "t",
      model: "t",
      complete: async (r: { user: string }) => {
        seen.push(r.user);
        return JSON.stringify({ title: "Done", script: `${words} version 14.11 shipped.`, mermaid: "flowchart LR\n  A[a] --> B[b]" });
      },
    };
    const r = await generateEarScript(llm, "report text");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("spell these out for speech: 14.11");
    expect(r.warnings).toEqual(["digits left in the script: 14.11"]);
  });
  it("takes the clean retry without a warning", async () => {
    let n = 0;
    const llm = {
      name: "t",
      model: "t",
      complete: async () => JSON.stringify({ title: "Done", script: n++ ? `${words} fourteen point eleven.` : `${words} 14.11.`, mermaid: "flowchart LR\n  A[a] --> B[b]" }),
    };
    const r = await generateEarScript(llm, "report text");
    expect(r.warnings).toEqual([]);
    expect(r.retries).toBe(1);
  });
});

describe("card.html is never followed through a symlink", () => {
  it("404s when card.html is a symlink", async () => {
    const id = "A1b2C3d4E5f6G7h8";
    mkdirSync(briefDir(id), { recursive: true });
    writeFileSync(join(home, "outside.html"), "<h1>outside</h1>");
    symlinkSync(join(home, "outside.html"), join(briefDir(id), "card.html"));
    const site = await createEarshotServer();
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(site.address() as AddressInfo).port}/b/${id}`);
      expect(res.status).toBe(404);
    } finally {
      site.close();
    }
  });
});

