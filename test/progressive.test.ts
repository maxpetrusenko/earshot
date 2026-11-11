import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { briefDir, createBrief, initialMeta, readMeta } from "../src/bundle.js";
import { newId } from "../src/lib/id.js";
import { DEFAULTS, parseConfig, ConfigError } from "../src/config.js";
import { streamEarScript } from "../src/ear-stream.js";
import { EarScriptError } from "../src/earscript.js";
import type { LlmProvider } from "../src/llm.js";
import { createEarshotServer, SERVED_FILES } from "../src/serve.js";
import { Semaphore, TrackWriter, type Synth } from "../src/track.js";
import { mp3Duration } from "../src/tts.js";
import { checkStory, QUOTE, STORY_SAMPLE } from "./story-checklist.js";
import { fakeMp3 } from "./helpers.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-prog-"));
  process.env.EARSHOT_HOME = home;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SENTENCES = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} says something about thing ${i + 1} for you.`);
const SCRIPT = SENTENCES.join(" ");
const json = (script: string, extra: Record<string, string> = {}) => JSON.stringify({ title: "A title", script, mermaid: "flowchart TD\n A[One] --> B[Two]", evidence: "", ...extra });

/** A fake model that emits the JSON in small pieces, with a pause between them, and records when it ends. */
function streamingLlm(text: string, pieceSize = 17, pauseMs = 5): LlmProvider & { ended: number | null; closed: boolean } {
  const llm = {
    name: "fake",
    model: "fake",
    ended: null as number | null,
    closed: false,
    complete: async () => text,
    async *stream() {
      try {
        for (let i = 0; i < text.length; i += pieceSize) {
          yield text.slice(i, i + pieceSize);
          await nap(pauseMs);
        }
        llm.ended = performance.now();
      } finally {
        llm.closed = true;
      }
    },
  };
  return llm;
}

describe("streamEarScript with a fake streamed LLM", () => {
  it("hands out speech chunks while the model is still writing", async () => {
    const llm = streamingLlm(json(SCRIPT));
    const chunkTimes: number[] = [];
    const chunks: string[] = [];
    const r = await streamEarScript(llm, "report", { onChunk: (c) => (chunks.push(c), chunkTimes.push(performance.now())) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunkTimes[0]).toBeLessThan(llm.ended!);
    expect(r.title).toBe("A title");
    expect(r.timing.first_sentence_ms).toBeLessThan(r.timing.first_token_ms! + 400);
    expect(chunks.join(" ")).toBe(r.script);
    expect(r.script).toContain("Sentence one says"); // digits are spelled out locally, no retry
    expect(r.script).not.toMatch(/\d/);
  });
  it("starts the sketch hook as soon as the diagram is complete", async () => {
    const llm = streamingLlm(json(SCRIPT));
    const seen: string[] = [];
    await streamEarScript(llm, "report", { onMermaid: (m) => seen.push(m) });
    expect(seen).toEqual(["flowchart TD\n A[One] --> B[Two]"]);
  });
  it("fails on a leaking sentence and stops reading the stream", async () => {
    const bad = SENTENCES.slice(0, 3).join(" ") + " Then open src/billing/webhook.ts to see it. " + SENTENCES.slice(3).join(" ");
    const llm = streamingLlm(json(bad));
    const chunks: string[] = [];
    await expect(streamEarScript(llm, "report", { onChunk: (c) => chunks.push(c) })).rejects.toThrow(/file path/);
    expect(chunks.join(" ")).not.toContain("webhook");
    expect(llm.closed).toBe(true);
    expect(llm.ended).toBeNull();
  });
  it("fails a script that is too short", async () => {
    await expect(streamEarScript(streamingLlm(json("Too short.")), "report", {})).rejects.toThrow(EarScriptError);
  });
  it("fails output that is not the JSON object", async () => {
    await expect(streamEarScript(streamingLlm("I cannot help with that, sorry."), "report", {})).rejects.toThrow(/no script/);
  });
  it("works with a provider that cannot stream (one piece)", async () => {
    const llm: LlmProvider = { name: "x", model: "x", complete: async () => json(SCRIPT) };
    const r = await streamEarScript(llm, "report", {});
    expect(r.words).toBeGreaterThan(60);
  });
  it("keeps a quoted post word for word and spells digits outside it", async () => {
    const quote = '"my agent finishes a task while i\'m driving. earshot turns it into a 40-70 s memo."';
    const script = `Hey, quick update. Two things are running. Here is the text for the post: ${quote} That takes 14 s now. ` + SENTENCES.join(" ");
    const r = await streamEarScript(streamingLlm(json(script)), "report", {});
    expect(r.script).toContain(quote);
    expect(r.script).toContain("takes fourteen s now");
  });
  it("only keeps an evidence link that the report contains", async () => {
    const url = "https://github.com/example/repo/pull/7";
    const r = await streamEarScript(streamingLlm(json(SCRIPT, { evidence: url })), `see ${url}`, {});
    expect(r.evidence).toBe(url);
    const r2 = await streamEarScript(streamingLlm(json(SCRIPT, { evidence: url })), "no link here", {});
    expect(r2.evidence).toBeNull();
  });
});

function pendingBrief() {
  const meta = initialMeta(newId(), { from: "stdin", chars: 1, redacted: 0, truncated: false }, "v");
  createBrief(meta, "input");
  return meta.id;
}
const synth = (frames = 8, delay = 0): Synth => async () => {
  if (delay) await nap(delay);
  return { audio: fakeMp3(frames), duration_s: null };
};

describe("progressive manifest", () => {
  it("lists each chunk as soon as it is on disk, then flips to ready with the joined file", async () => {
    const id = pendingBrief();
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(2), synth: synth(8, 10) });
    w.add("First chunk.");
    await nap(80);
    let t = readMeta(id)!.tracks!.edited;
    expect(t.status).toBe("pending");
    expect(t.chunks.map((c) => c.file)).toEqual(["edited-000.mp3"]);
    expect(t.first_audio_ms).toBeGreaterThan(0);
    w.add("Second chunk.");
    w.add("Third chunk.");
    await w.close();
    t = readMeta(id)!.tracks!.edited;
    expect(t.status).toBe("ready");
    expect(t.chunks.map((c) => c.file)).toEqual(["edited-000.mp3", "edited-001.mp3", "edited-002.mp3"]);
    const joined = readFileSync(join(briefDir(id), "edited.mp3"));
    expect(joined.length).toBe(417 * 8 * 3);
    expect(t.duration_s).toBe(mp3Duration(joined));
    expect(readMeta(id)!.tracks!.original.status).toBe("pending"); // the other track is untouched
  });
  it("a failed chunk fails the track and removes its files", async () => {
    const id = pendingBrief();
    let n = 0;
    const flaky: Synth = async () => {
      if (++n >= 2) throw new Error("tts HTTP 500");
      return { audio: fakeMp3(8), duration_s: null };
    };
    const w = new TrackWriter({ id, track: "original", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: flaky });
    w.add("One.");
    w.add("Two.");
    await w.close();
    const t = readMeta(id)!.tracks!.original;
    expect(t.status).toBe("failed");
    expect(t.chunks).toEqual([]);
    expect(readdirSync(briefDir(id)).filter((f) => f.startsWith("original"))).toEqual([]);
  });
  it("holds chunks after the first until the other track has its first chunk", async () => {
    const id = pendingBrief();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const rec: Synth = async (_c, text) => {
      calls.push(text);
      return { audio: fakeMp3(8), duration_s: null };
    };
    const w = new TrackWriter({ id, track: "original", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(2), holdAfterFirst: hold, synth: rec });
    w.add("One.");
    w.add("Two.");
    await nap(60);
    expect(calls).toEqual(["One."]);
    release();
    await w.close();
    expect(calls).toEqual(["One.", "Two."]);
    expect(readMeta(id)!.tracks!.original.status).toBe("ready");
  });
  it("retries a chunk once", async () => {
    const id = pendingBrief();
    let n = 0;
    const once: Synth = async () => {
      if (++n === 1) throw new Error("tts HTTP 503");
      return { audio: fakeMp3(8), duration_s: null };
    };
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: once });
    w.add("One.");
    await w.close();
    expect(readMeta(id)!.tracks!.edited.status).toBe("ready");
  });
  it("rejects a chunk whose audio format differs from the first", async () => {
    const id = pendingBrief();
    let n = 0;
    const mixed: Synth = async () => {
      const f = Buffer.from(fakeMp3(8));
      if (++n === 2) f[2] = 0x94; // 44.1 kHz becomes 48 kHz
      return { audio: f, duration_s: null };
    };
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: mixed });
    w.add("One.");
    w.add("Two.");
    await w.close();
    expect(readMeta(id)!.tracks!.edited.status).toBe("failed");
  });
});

describe("serving a growing track", () => {
  let site: Server;
  let base: string;
  beforeAll(async () => {
    site = await createEarshotServer();
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => site.close());

  it("allows exactly the listed files", () => {
    expect(Object.keys(SERVED_FILES).sort()).toEqual(["edited.mp3", "memo.mp3", "meta.json", "original.mp3", "sketch.png", "sketch.svg"]);
  });

  it("answers 404 for chunk files, the old name, other cases and near misses", async () => {
    const id = pendingBrief();
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: synth() });
    w.add("One.");
    await w.close();
    for (const f of ["edited-000.mp3", "edited-001.mp3", "original-000.mp3", "Edited.mp3", "edited.mp3.bak", "edited.mp3%00.txt", "..%2Fedited.mp3", "edited.mp3/x"]) {
      expect((await fetch(`${base}/b/${id}/${f}`)).status, f).toBe(404);
    }
    expect((await fetch(`${base}/b/${id}/edited.mp3`)).status).toBe(200);
    expect((await fetch(`${base}/b/${id.slice(0, 15)}/edited.mp3`)).status).toBe(404);
  });

  it("streams chunks while the track is pending, then closes", async () => {
    const id = pendingBrief();
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: synth(10, 30) });
    const t0 = performance.now();
    const res = await fetch(`${base}/b/${id}/edited.mp3`); // opened before any audio exists
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBe("none");
    w.add("One.");
    const reader = res.body!.getReader();
    const first = await reader.read();
    const ttfb = performance.now() - t0;
    expect(first.value!.length).toBe(417 * 10);
    w.add("Two.");
    w.add("Three.");
    const parts: Uint8Array[] = [first.value!];
    let closedAfterReady = false;
    const finishing = w.close().then(() => (closedAfterReady = true));
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
    }
    await finishing;
    expect(closedAfterReady).toBe(true);
    const got = Buffer.concat(parts);
    expect(got.equals(readFileSync(join(briefDir(id), "edited.mp3")))).toBe(true);
    expect(ttfb).toBeLessThan(2000);
  });

  it("serves the finished track with Content-Length and ranges", async () => {
    const id = pendingBrief();
    const w = new TrackWriter({ id, track: "original", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: synth() });
    w.add("One.");
    w.add("Two.");
    await w.close();
    const full = await fetch(`${base}/b/${id}/original.mp3`);
    expect(full.headers.get("content-length")).toBe(String(417 * 16));
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const part = await fetch(`${base}/b/${id}/original.mp3`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it("ends the stream and 404s a track that failed", async () => {
    const id = pendingBrief();
    const bad: Synth = async () => {
      await nap(150);
      throw new Error("tts HTTP 500");
    };
    const w = new TrackWriter({ id, track: "edited", tts: DEFAULTS.tts, t0: performance.now(), gate: new Semaphore(1), synth: bad });
    const pending = fetch(`${base}/b/${id}/edited.mp3`).then((r) => r.arrayBuffer());
    w.add("One.");
    await w.close();
    expect((await pending).byteLength).toBe(0);
    expect((await fetch(`${base}/b/${id}/edited.mp3`)).status).toBe(404);
  });

  it("404s a brief with audio off", async () => {
    const id = pendingBrief();
    const { updateMeta } = await import("../src/bundle.js");
    updateMeta(id, (m) => void (m.tracks = null));
    expect((await fetch(`${base}/b/${id}/edited.mp3`)).status).toBe(404);
  });
});

describe("tts profiles", () => {
  const yaml = `tts:\n  profile: max\n  profiles:\n    fast:\n      base_url: http://localhost:8880/v1\n    max:\n      base_url: http://localhost:8881/v1\n      model: f5\n      voice: me\n      timeout_s: 300\n`;
  it("merges the active profile over the base values", () => {
    const c = parseConfig(yaml);
    expect(c.tts).toMatchObject({ base_url: "http://localhost:8881/v1", model: "f5", voice: "me", timeout_s: 300, profile: "max" });
    expect(parseConfig(yaml.replace("profile: max", "profile: fast")).tts).toMatchObject({ base_url: "http://localhost:8880/v1", model: "kokoro", voice: "af_heart" });
  });
  it("rejects an unknown profile and unknown profile keys", () => {
    expect(() => parseConfig(yaml.replace("profile: max", "profile: nope"))).toThrow(ConfigError);
    expect(() => parseConfig(yaml.replace("model: f5", "colour: red"))).toThrow(/unknown key/);
  });
  it("reads script.style", () => {
    expect(parseConfig("").script.style).toBe("short");
    expect(parseConfig("script:\n  style: story\n").script.style).toBe("story");
    expect(parseConfig("script:\n  style: brief\n").script.style).toBe("brief");
    expect(() => parseConfig("script:\n  style: poem\n")).toThrow(ConfigError);
  });
});

describe("story style checklist", () => {
  it("passes a good story", () => {
    expect(checkStory(STORY_SAMPLE.script, STORY_SAMPLE.quote)).toEqual([]);
  });
  it("catches a terse status", () => {
    const bad = "Both workers are running. Worker 1: one repo, two tracks. Post A text for X, recommended: my agent finishes a task.";
    const problems = checkStory(bad, STORY_SAMPLE.quote);
    expect(problems.join(" ")).toMatch(/opener/);
    expect(problems.join(" ")).toMatch(/quote/);
    expect(problems.join(" ")).toMatch(/asks/);
  });
});

describe("provider streams", () => {
  it("openai-compatible: reads an SSE answer piece by piece, and a whole JSON answer", async () => {
    const { createServer } = await import("node:http");
    const { openAiProvider } = await import("../src/llm.js");
    const full = json(SCRIPT);
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        if (!JSON.parse(body).stream) return res.end("{}");
        if (req.url?.includes("whole")) {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ choices: [{ message: { content: full } }] }));
        }
        res.setHeader("content-type", "text/event-stream");
        for (let i = 0; i < full.length; i += 40) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(i, i + 40) } }] })}\n\n`);
          await nap(2);
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      for (const path of ["v1", "whole/v1"]) {
        const llm = openAiProvider({ ...DEFAULTS.llm, type: "openai-compatible", base_url: `${url}/${path}`, model: "m" });
        const pieces: string[] = [];
        for await (const p of llm.stream!({ system: "s", user: "u", json: true })) pieces.push(p);
        expect(pieces.join("")).toBe(full);
        if (path === "v1") expect(pieces.length).toBeGreaterThan(3);
      }
    } finally {
      srv.close();
    }
  });
  it("claude-cli: reads stream-json deltas and stops the child when the reader leaves early", async () => {
    const { writeFileSync } = await import("node:fs");
    const { claudeCliProvider } = await import("../src/llm.js");
    const ev = (t: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    const path = join(home, "fake-claude-stream.sh");
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\necho '{"type":"system"}'\necho '${ev("Hello ")}'\necho '${ev("world")}'\necho '{"type":"result","result":"Hello world"}'\n`, { mode: 0o755 });
    const llm = claudeCliProvider({ ...DEFAULTS.llm, command: path });
    const got: string[] = [];
    for await (const p of llm.stream!({ system: "s", user: "u" })) got.push(p);
    expect(got).toEqual(["Hello ", "world"]);
    // No deltas, only the final result: the result text is used.
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\necho '{"type":"result","result":"Whole answer"}'\n`, { mode: 0o755 });
    const whole: string[] = [];
    for await (const p of llm.stream!({ system: "s", user: "u" })) whole.push(p);
    expect(whole).toEqual(["Whole answer"]);
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\necho oops >&2\nexit 3\n`, { mode: 0o755 });
    await expect((async () => { for await (const p of llm.stream!({ system: "s", user: "u" })) void p; })()).rejects.toThrow(/exited 3/);
  });
});

describe("briefs made before progressive tracks (regression: links went 404 after the upgrade)", () => {
  let site: Server;
  let base: string;
  let id: string;
  const audio = fakeMp3(40);
  beforeAll(async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    id = newId();
    const dir = join(home, "briefs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memo.mp3"), audio);
    writeFileSync(join(dir, "sketch.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(join(dir, "script.md"), "Old title\n\nFirst old paragraph.\n\nSecond old paragraph.\n");
    writeFileSync(join(dir, "card.html"), '<html><audio id="audio" src="/b/x/memo.mp3"></audio><button id="play"></button></html>');
    // The exact shape the previous release wrote: audio, image, no tracks, no timing.
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ id, created_at: "2026-11-11T17:11:17.491Z", source: { from: "stdin", chars: 10, redacted: 0, truncated: false }, title: "Old title", status: "ready", error: null, audio: { duration_s: 55.8, voice: "af_heart", provider: "openai-compatible" }, image: { renderer: "beautiful-mermaid", mermaid: "flowchart TD\n A[x] --> B[y]" }, evidence: null, prompt: "ear-script.v0", stages: [], total_ms: 1000 }),
    );
    site = await createEarshotServer();
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => site.close());

  it("serves the old memo.mp3 with ranges", async () => {
    const r = await fetch(`${base}/b/${id}/memo.mp3`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await r.arrayBuffer()).equals(audio)).toBe(true);
    expect((await fetch(`${base}/b/${id}/memo.mp3`, { headers: { range: "bytes=0-9" } })).status).toBe(206);
  });
  it("answers edited.mp3 with the old memo and has no original", async () => {
    const r = await fetch(`${base}/b/${id}/edited.mp3`);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(audio)).toBe(true);
    expect((await fetch(`${base}/b/${id}/original.mp3`)).status).toBe(404);
  });
  it("renders the card from the current template, with the transcript", async () => {
    const r = await fetch(`${base}/b/${id}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('id="play-edited"');
    expect(html).toContain('id="play-original" class="choice" type="button" data-track="original" disabled');
    expect(html).toContain("First old paragraph.");
    expect(html).not.toContain('id="play"');
  });
  it("gives meta.json the track fields the card reads", async () => {
    const m = (await (await fetch(`${base}/b/${id}/meta.json`)).json()) as { tracks: { edited: { status: string; duration_s: number }; original: { status: string } } };
    expect(m.tracks.edited).toMatchObject({ status: "ready", duration_s: 55.8 });
    expect(m.tracks.original.status).toBe("failed");
  });
  it("still serves the sketch", async () => {
    expect((await fetch(`${base}/b/${id}/sketch.svg`)).status).toBe(200);
  });
});

describe("story fixture", () => {
  const fixture = readFileSync(join(import.meta.dirname, "fixtures", "orchestrator-status.txt"), "utf8");
  it("holds the post text the checklist expects, and no real host", () => {
    expect(fixture).toContain(`"${QUOTE}"`);
    expect(fixture).not.toMatch(/\.ts\.net|\b\d+\.\d+\.\d+\.\d+\b/);
  });
  // Live check against the real model: EARSHOT_LIVE=1 pnpm test test/progressive.test.ts
  it.skipIf(!process.env.EARSHOT_LIVE)("a generated story passes the checklist", async () => {
    const { createLlm } = await import("../src/llm.js");
    const r = await streamEarScript(createLlm(DEFAULTS.llm), fixture, {});
    expect(checkStory(r.script)).toEqual([]);
  }, 120_000);
});
