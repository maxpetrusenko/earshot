import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveBaseUrl, parseTailscaleStatus } from "../src/baseurl.js";
import { escapeHtml, renderCard } from "../src/card.js";
import { ConfigError, DEFAULTS, parseConfig, resolveKey } from "../src/config.js";
import { checkScript, countWords, extractJson, validEvidence } from "../src/earscript.js";
import { extractStdin, normalizeInput, truncateMiddle } from "../src/extract/stdin.js";
import { initialMeta } from "../src/bundle.js";
import { isValidId, newId } from "../src/lib/id.js";
import { redact } from "../src/redact.js";
import { serveConflict, validateBindHost, validatePort } from "../src/serve-cmd.js";
import { parseRange } from "../src/serve.js";
import { validateMermaid } from "../src/sketch.js";
import { sanitizeSvg } from "../src/svg-sanitize.js";
import { mp3Duration } from "../src/tts.js";
import { fakeMp3 } from "./helpers.js";

describe("redact", () => {
  const cases: [string, string][] = [
    ["key sk-ant-api03-abcdefghijklmnop1234", "sk-ant"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ["slack xoxb-123456789012-abcdefghij", "xoxb"],
    ["aws AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
    ["Authorization: Bearer abcdefghijklmnop.qrstuvwx-yz", "abcdefghijklmnop"],
    ["OPENAI_API_KEY=abc123def456", "abc123def456"],
    ["export GITHUB_TOKEN=\"s3cr3t value\"", "s3cr3t"],
    ["db_password = hunter2hunter2", "hunter2"],
    ["TOKEN=plainvalue", "plainvalue"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY-----", "MIIEabc"],
    ["-----BEGIN PRIVATE KEY-----\ntruncated base64 with no end", "truncated base64"],
  ];
  for (const [input, secret] of cases) {
    it(`scrubs ${secret.slice(0, 14)}`, () => {
      const r = redact(input);
      expect(r.text).not.toContain(secret);
      expect(r.count).toBeGreaterThan(0);
    });
  }
  it("leaves ordinary text alone", () => {
    const txt = "MAX_ATTEMPTS = 5, the key point is that the task-runner took a token amount of time. sk-short.";
    expect(redact(txt)).toEqual({ text: txt, count: 0 });
  });
  it("keeps the variable name, drops the value", () => {
    expect(redact("STRIPE_SECRET_KEY=whsec_123").text).toBe("STRIPE_SECRET_KEY=[REDACTED]");
  });
});

describe("config", () => {
  it("applies defaults to an empty file", () => {
    expect(parseConfig("")).toEqual(DEFAULTS);
  });
  it("rejects unknown keys with the key name", () => {
    expect(() => parseConfig("llm:\n  modle: x\n")).toThrow('unknown key "llm.modle"');
    expect(() => parseConfig("bogus: 1\n")).toThrow('unknown key "bogus"');
  });
  it("rejects wrong types and bad enums", () => {
    expect(() => parseConfig("serve:\n  port: abc\n")).toThrow(ConfigError);
    expect(() => parseConfig("serve:\n  mode: public\n")).toThrow("serve.mode");
    expect(() => parseConfig("llm:\n  type: openai-compatible\n")).toThrow("base_url");
  });
  it("resolves api_key_env and names a missing variable", () => {
    expect(resolveKey("", {})).toBeUndefined();
    expect(resolveKey("K", { K: "v" })).toBe("v");
    expect(() => resolveKey("MISSING_VAR", {})).toThrow("MISSING_VAR");
  });
});

describe("id and range", () => {
  it("generates valid ids", () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isValidId(id)).toBe(true);
  });
  it("rejects bad ids", () => {
    for (const bad of ["", "short", "../../etc/passwd0", "A".repeat(15), "A".repeat(17), "AAAAAAAAAAAAAAA/", "AAAAAAAAAAAAAAA%"]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
  it("parses byte ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=200-300", 100)).toBe("invalid");
    expect(parseRange("garbage", 100)).toBe("invalid");
    expect(parseRange("", 100)).toBeNull();
  });
});

describe("html escaping", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
  it("renders hostile strings as text", () => {
    const meta = initialMeta("AAAAAAAAAAAAAAAA", { from: "stdin", chars: 1, redacted: 0, truncated: false }, "v0");
    meta.status = "ready";
    meta.title = "<script>alert(1)</script>";
    meta.evidence = 'https://x.test/"onmouseover="alert(1)';
    const html = renderCard(meta, '<img src=x onerror=alert(1)>\n\n"quoted" & more');
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('"onmouseover="');
    expect(html).not.toMatch(/<script(?![^>]*src="\/assets\/card\.js")/);
    expect(html).not.toMatch(/<[^>]*\son\w+=/);
  });
  it("renders failed state without a player or transcript", () => {
    const meta = initialMeta("AAAAAAAAAAAAAAAA", { from: "stdin", chars: 1, redacted: 0, truncated: false }, "v0");
    meta.status = "failed";
    meta.error = "boom <b>";
    const html = renderCard(meta, null);
    expect(html).toContain("boom &lt;b&gt;");
    expect(html).not.toContain('id="audio"');
  });
});

describe("stdin extractor", () => {
  it("normalizes BOM, CRLF and ANSI", () => {
    expect(normalizeInput("﻿\u001b[32mhello\u001b[0m\r\nworld  \n")).toBe("hello\nworld");
  });
  it("truncates from the middle, keeping head and tail", () => {
    const t = truncateMiddle("a".repeat(500) + "MID" + "z".repeat(500), 100);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith("aaaa")).toBe(true);
    expect(t.text.endsWith("zzzz")).toBe(true);
    expect(t.text).not.toContain("MID");
    expect(truncateMiddle("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("reads a stream", async () => {
    const r = await extractStdin(Readable.from(["  one ", "two\n"]), 1000);
    expect(r.text).toBe("one two");
    expect(r.chars).toBe(7);
  });
});

describe("earscript helpers", () => {
  it("extracts JSON from messy output", () => {
    expect(extractJson('Sure!\n```json\n{"a": "x } y", "b": {"c": 1}}\n```\nthanks')).toEqual({ a: "x } y", b: { c: 1 } });
    expect(() => extractJson("no json here")).toThrow();
    expect(() => extractJson('{"a": ')).toThrow();
  });
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  it("checks word count", () => {
    expect(countWords(words(5))).toBe(5);
    expect(checkScript(words(40))).toContain("at least");
    expect(checkScript(words(300))).toContain("at most");
    expect(checkScript(words(120))).toBeNull();
  });
  it("flags path, code and url leaks", () => {
    for (const leak of ["see src/billing/webhook.ts now", "run `pnpm test`", "open https://x.test/a", "the MAX_ATTEMPTS value", "commit 9fceb02d0ae598e", "in /usr/local/bin"]) {
      expect(checkScript(`${words(120)} ${leak}`), leak).not.toBeNull();
    }
    expect(checkScript(`${words(120)} and/or either way, about forty percent`)).toBeNull();
  });
  it("accepts evidence only when the report contains the URL", () => {
    const input = "see https://github.com/a/b/pull/1 for details";
    expect(validEvidence("https://github.com/a/b/pull/1", input)).toBe("https://github.com/a/b/pull/1");
    expect(validEvidence("https://evil.test/x", input)).toBeNull();
    expect(validEvidence("javascript:alert(1)", "javascript:alert(1)")).toBeNull();
    expect(validEvidence(42, input)).toBeNull();
  });
});

describe("svg sanitizer", () => {
  it("strips scripts, foreignObject, handlers and external references", () => {
    const dirty = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
<style>@import url('https://fonts.example/x.css?a=1;b=2&amp;display=swap'); text { font-family: x; background: url(https://evil.test/a.png) }</style>
<script>alert(1)</script><foreignObject><div>hi</div></foreignObject>
<a href="javascript:alert(1)"><rect x="1" y="1" width="5" height="5" fill="url(#g)" onclick="x()"/></a>
<image href="https://evil.test/p.png"/><use href="#a"/><text x="1" y="1" style="fill: url(https://evil.test)">A &amp; B</text>
<rect fill="javascript:alert(1)" width="1" height="1"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|foreignobject|onload|onclick|@import|evil\.test|javascript:|<image|<use|<a[ >]|<div/i);
    expect(clean).toContain("<rect");
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain("A &amp; B");
    expect(clean).not.toMatch(/display=swap|fonts\.example/);
  });
  it("keeps normal renderer output", () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><g class="node" data-id="A"><rect x="0" y="0" rx="2" width="4" height="4"/><text x="1" y="1">A</text></g></svg>';
    expect(sanitizeSvg(ok)).toBe(ok);
  });
});

describe("mermaid validation", () => {
  it("accepts the prompt's shape", () => {
    expect(validateMermaid("flowchart LR\n  A[One] --> B[Two]\n  B -.-> C[Three]")).toBeNull();
  });
  it("rejects styling, quotes and other diagram types", () => {
    expect(validateMermaid('flowchart LR\n  A["One"] --> B[Two]')).not.toBeNull();
    expect(validateMermaid("sequenceDiagram\n A->>B: hi")).not.toBeNull();
    expect(validateMermaid("flowchart LR\n  A[One] --> B[Two]\n  style A fill:#f00;")).not.toBeNull();
    expect(validateMermaid("flowchart LR\n  A[Only]")).not.toBeNull();
  });
});

describe("mp3 and base url", () => {
  it("reads mp3 duration from frames", () => {
    expect(mp3Duration(fakeMp3(100))).toBeCloseTo(2.6, 1);
    expect(mp3Duration(Buffer.from("not an mp3"))).toBeNull();
  });
  const ts = { dnsName: "pro.tail1234.ts.net", ip4: "100.64.0.9" };
  it("resolves base urls from the serve block", () => {
    expect(resolveBaseUrl({ mode: "loopback", port: 7777, https_port: 443 }, {})).toBe("http://localhost:7777");
    expect(resolveBaseUrl({ mode: "tailnet-ip", port: 7777, https_port: 443 }, ts)).toBe("http://100.64.0.9:7777");
    expect(resolveBaseUrl({ mode: "tailscale-serve", port: 7777, https_port: 443 }, ts)).toBe("https://pro.tail1234.ts.net");
    expect(resolveBaseUrl({ mode: "tailscale-serve", port: 7777, https_port: 8443 }, ts)).toBe("https://pro.tail1234.ts.net:8443");
    expect(() => resolveBaseUrl({ mode: "tailnet-ip", port: 1, https_port: 443 }, {})).toThrow();
  });
  it("parses tailscale status json", () => {
    const j = JSON.stringify({ Self: { DNSName: "pro.tail1234.ts.net.", TailscaleIPs: ["100.64.0.9", "fd7a::1"] } });
    expect(parseTailscaleStatus(j)).toEqual(ts);
  });
  it("detects a conflicting tailscale serve handler", () => {
    const st = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "pro.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
    expect(serveConflict(st, 443, "http://127.0.0.1:7777")).toContain("3000");
    expect(serveConflict(st, 8443, "http://127.0.0.1:7777")).toBeNull();
    expect(serveConflict("{}", 443, "http://127.0.0.1:7777")).toBeNull();
    const same = JSON.stringify({ TCP: { "443": {} }, Web: { "pro.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7777" } } } } });
    expect(serveConflict(same, 443, "http://127.0.0.1:7777")).toBeNull();
  });
});

describe("renderer", () => {
  const samples = [
    "flowchart LR\n  A[Endpoint fails] --> B[Count on job]\n  B --> C[Stop at five]\n  C -.-> D[Old rows left]",
    "flowchart TD\n  A[Request] --> B[Cache]\n  B --> C[Database]",
    "flowchart LR\n  A[One] -.-> B[Two]\n  B -.-> C[Three]",
    "flowchart TD\n  A[Build] --> B[Test]\n  A --> C[Lint]\n  B --> D[Ship]\n  C --> D",
    "flowchart LR\n  A[Short] --> B[A little longer label] --> C[End]",
  ];
  it("renders every sample to a clean svg", async () => {
    const { renderSketch } = await import("../src/sketch.js");
    for (const s of samples) {
      const svg = await renderSketch(s);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/@import|<script|foreignobject|googleapis/i);
    }
  });
  it("marks dashed edges", async () => {
    const { renderSketch } = await import("../src/sketch.js");
    expect(await renderSketch(samples[2]!)).toContain("stroke-dasharray");
  });
});

describe("private hosts bypass the proxy", () => {
  it("classifies hosts", async () => {
    const { isPrivateHost } = await import("../src/lib/net.js");
    for (const h of ["localhost", "127.0.0.1", "100.64.0.7", "192.168.1.5", "10.0.0.2", "172.20.1.1", "mac.example.ts.net", "mymac.local", "[::1]"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["api.openai.com", "100.63.0.1", "172.32.0.1", "8.8.8.8", "example.ts.net.evil.com"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});

describe("redact: reviewed gaps", () => {
  const cases: [string, string][] = [
    ["password=hunter2", "hunter2"],
    ["token=abcd1234", "abcd1234"],
    ['{"password": "x1y2z3", "user": "bob"}', "x1y2z3"],
    ["api_key: abcdef123456", "abcdef123456"],
    ["apiKey: 'zz99yy88'", "zz99yy88"],
    ["DB_PASSWORD: s3cretpass", "s3cretpass"],
    ["postgres://admin:pw0rd@db.internal:5432/app", "pw0rd"],
    ["https://ghtoken123@github.com/a/b", "ghtoken123"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["Authorization: Bearer abc123", "abc123"],
    ["https://x.test/cb?token=abc987&ok=1", "abc987"],
    ["https://x.test/a?access_token=tok55&b=2", "tok55"],
    ["https://x.test/a?x=1&api_key=k77k77", "k77k77"],
    ["https://x.test/a?key=kk4455", "kk4455"],
    ["https://x.test/a?secret=ss1122", "ss1122"],
    ["https://bucket.s3.test/f?sig=sig8899&e=1", "sig8899"],
    ["credential = cr3d3nt", "cr3d3nt"],
    ["pwd=mypwd1", "mypwd1"],
    ["private_key=pk12345", "pk12345"],
  ];
  for (const [input, secret] of cases) {
    it(`scrubs ${input.slice(0, 32)}`, () => {
      const r = redact(input);
      expect(r.text).not.toContain(secret);
      expect(r.count).toBeGreaterThan(0);
    });
  }
  it("keeps non-secret neighbours and ordinary prose", () => {
    expect(redact('{"password": "x1y2z3", "user": "bob"}').text).toContain('"user": "bob"');
    expect(redact("https://x.test/a?token=abc987&ok=1").text).toContain("&ok=1");
    const prose = "The author wrote a note. Keys are rotated; see https://github.com/a/b/pull/4?diff=split.";
    expect(redact(prose)).toEqual({ text: prose, count: 0 });
  });
});

describe("evidence url hygiene", () => {
  it("drops links with userinfo or secret query params", () => {
    for (const u of ["https://user:pw@x.test/a", "https://tok@x.test/a", "https://x.test/a?token=1", "https://x.test/a?api_key=1", "https://x.test/a?sig=1", "https://x.test/[REDACTED]"]) {
      expect(validEvidence(u, `see ${u}`), u).toBeNull();
    }
    expect(validEvidence("https://github.com/a/b/pull/4?diff=split", "https://github.com/a/b/pull/4?diff=split")).not.toBeNull();
  });
});

describe("bind host and port validation", () => {
  it("allows loopback and tailnet addresses only", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "[::1]", "100.64.0.1", "100.64.0.7", "100.127.255.1"]) {
      expect(() => validateBindHost(h), h).not.toThrow();
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "100.63.0.1", "100.128.0.1", "example.com", ""]) {
      expect(() => validateBindHost(h), h).toThrow(/not allowed/);
    }
  });
  it("validates ports", () => {
    expect(validatePort(7777)).toBe(7777);
    for (const p of [0, 65536, -1, 1.5, NaN, "80", undefined]) expect(() => validatePort(p)).toThrow(/1 to 65535/);
  });
});

describe("svg css escapes", () => {
  it("neutralizes escaped url() and image-set", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>a{background:u\\72l(https://evil.test/x)} b{background:image-set("https://evil.test/y" 1x)} c{x:\\75rl(https://evil.test/z)}</style><rect style="fill:\\75rl(https://evil.test/q)"/></svg>';
    const clean = sanitizeSvg(svg);
    expect(clean).not.toMatch(/image-set|url\(/i);
  });
});
