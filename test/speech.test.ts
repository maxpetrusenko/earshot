import { describe, expect, it } from "vitest";
import { chunkText, Chunker, numberToWords, plainName, SentenceSplitter, speakableOriginal, spellDigits, spokenPath } from "../src/speech.js";
import { JsonFieldStream } from "../src/stream-json.js";
import { claudeStreamText, sseDelta } from "../src/llm.js";
import { mp3Format, stripMp3Meta } from "../src/tts.js";
import { fakeMp3 } from "./helpers.js";

describe("numberToWords", () => {
  it.each([
    ["0", "zero"],
    ["7", "seven"],
    ["13", "thirteen"],
    ["40", "forty"],
    ["21", "twenty-one"],
    ["100", "one hundred"],
    ["101", "one hundred one"],
    ["1200", "one thousand two hundred"],
    ["1000000", "one million"],
    ["000", "zero"],
  ])("%s", (n, words) => expect(numberToWords(n)).toBe(words));
});

describe("spellDigits", () => {
  it("spells integers, decimals, percents, ordinals, money and years", () => {
    expect(spellDigits("It took 14 s and 3 retries.")).toBe("It took fourteen s and three retries.");
    expect(spellDigits("About 40% faster, 1.5 KB.")).toBe("About forty percent faster, one point five KB.");
    expect(spellDigits("The 2nd and 21st try.")).toBe("The second and twenty-first try.");
    expect(spellDigits("It costs $5 and 1,200 rows.")).toBe("It costs five dollars and one thousand two hundred rows.");
    expect(spellDigits("In 2026 we shipped.")).toBe("In twenty twenty-six we shipped.");
  });
  it("leaves no digit behind outside quotes", () => {
    expect(spellDigits("v2 uses h264 and 3.14.159")).not.toMatch(/\d/);
  });
  it("keeps quoted text exactly as written, across sentences", () => {
    const state = { inQuote: false };
    const a = spellDigits('Here is the post: "turns output into a 40-70 s memo.', state);
    const b = spellDigits('About 14 s later." Then 3 more.', state);
    expect(a).toBe('Here is the post: "turns output into a 40-70 s memo.');
    expect(b).toBe('About 14 s later." Then three more.');
    expect(state.inQuote).toBe(false);
  });
});

describe("SentenceSplitter and chunking", () => {
  it("cuts at sentence ends only when the next text has started", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hey there. This is")).toEqual(["Hey there."]);
    expect(s.push(" the second one! And a third")).toEqual(["This is the second one!"]);
    expect(s.flush()).toEqual(["And a third"]);
  });
  it("does not split decimals, file names or abbreviations", () => {
    const s = new SentenceSplitter();
    expect(s.push("It took 1.5 seconds, e.g. a lot. Next one. ")).toEqual(["It took 1.5 seconds, e.g. a lot.", "Next one."]);
  });
  it("keeps a closing quote with its sentence", () => {
    const s = new SentenceSplitter();
    expect(s.push('He said "go now." Then left. ')).toEqual(['He said "go now."', "Then left."]);
  });
  it("handles pieces of any size", () => {
    const s = new SentenceSplitter();
    const out: string[] = [];
    for (const ch of "One fish. Two fish. Red fish. ") out.push(...s.push(ch));
    expect(out).toEqual(["One fish.", "Two fish.", "Red fish."]);
  });
  it("emits a small first chunk, then larger ones, and flushes the rest", () => {
    const c = new Chunker({ firstMin: 20, target: 40 });
    expect(c.push("Hey, quick update here.")).toEqual(["Hey, quick update here."]);
    expect(c.push("Short one.")).toEqual([]);
    expect(c.push("A second sentence that is long enough to go.")).toEqual(["Short one. A second sentence that is long enough to go."]);
    expect(c.push("Tail.")).toEqual([]);
    expect(c.flush()).toEqual(["Tail."]);
    expect(c.flush()).toEqual([]);
  });
  it("ramps chunk size: small first, then a small second, then large", () => {
    const c = new Chunker({ firstMin: 10, second: 30, target: 70 });
    const sent = "This is a sentence of forty chars here.";
    expect(c.push(sent)).toEqual([sent]);
    expect(c.push(sent)).toEqual([sent]);
    expect(c.push(sent)).toEqual([]);
    expect(c.push(sent)).toEqual([`${sent} ${sent}`]);
  });
  it("joins a too-short first sentence with the next", () => {
    expect(chunkText("Hi. This is a longer second sentence that follows. And more.", { firstMin: 30, target: 500 })).toEqual(["Hi. This is a longer second sentence that follows.", "And more."]);
  });
  it("chunkText loses no words", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    expect(chunkText(text).join(" ")).toBe(text);
  });
});

describe("speakableOriginal", () => {
  it("drops code blocks, urls and hashes, and names paths", () => {
    const out = speakableOriginal("Fixed `src/billing/webhook.ts` in commit 9fceb02d0ae598e.\n\n```ts\nconst x = 1;\n```\nSee https://github.com/a/b/pull/3 now.");
    expect(out).toContain("the webhook file");
    expect(out).not.toMatch(/const x|9fceb|https|src\//);
    expect(out).toContain("a link");
  });
  it("turns bullets and headings into sentences and drops table rows", () => {
    const out = speakableOriginal("# Status\n- First thing\n- Second thing\n| a | b |\n|---|---|\n");
    expect(out.split("\n")).toEqual(["Status.", "First thing.", "Second thing."]);
  });
  it("de-snakes identifiers and strips markup", () => {
    expect(speakableOriginal("The **retry_count** is `maxAttempts`.")).toBe("The retry count is max attempts.");
  });
  it("names paths", () => {
    expect(spokenPath("src/billing/webhook.ts")).toBe("the webhook file");
    expect(spokenPath("~/work/index.ts")).toBe("the work file");
    expect(plainName("retryWithBackoff")).toBe("retry with backoff");
  });
  it("caps very long text at a sentence end", () => {
    const out = speakableOriginal("A sentence here. ".repeat(2000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(".")).toBe(true);
  });
});

describe("JsonFieldStream", () => {
  const FULL = JSON.stringify({ title: "A title", script: 'He said "hi"\nthen left é.', mermaid: "flowchart TD\n A[x] --> B[y]", evidence: "" });
  const run = (pieces: string[]) => {
    const deltas: string[] = [];
    const fields: Record<string, string> = {};
    const s = new JsonFieldStream({ delta: (k, t) => k === "script" && deltas.push(t), field: (k, v) => (fields[k] = v) });
    for (const p of pieces) s.push(p);
    return { deltas, fields, s };
  };
  it("decodes fields from one piece", () => {
    const { fields } = run([FULL]);
    expect(fields.title).toBe("A title");
    expect(fields.script).toBe('He said "hi"\nthen left é.');
    expect(fields.mermaid).toContain("flowchart TD\n A[x]");
    expect(fields.evidence).toBe("");
  });
  it("gives the same result when split at every character, including inside escapes", () => {
    const { fields, deltas } = run([...FULL]);
    expect(fields.script).toBe('He said "hi"\nthen left é.');
    expect(deltas.join("")).toBe(fields.script);
  });
  it("streams script text before the object ends", () => {
    const { deltas, fields } = run(['```json\n{"title": "T", "script": "First sentence. Second', " one.", '", "mermaid": "x"}']);
    expect(deltas.join("")).toBe("First sentence. Second one.");
    expect(fields.mermaid).toBe("x");
  });
  it("skips non-string values and nested objects", () => {
    const { fields } = run(['{"n": 5, "o": {"a": "b,\\"}"}, "list": [1, "x"], "script": "ok"}']);
    expect(fields).toEqual({ script: "ok" });
  });
  it("counts no fields for text that is not JSON", () => {
    expect(run(["just words, no object"]).s.fields).toBe(0);
  });
});

describe("stream line parsers", () => {
  it("reads claude stream-json text deltas and the final result", () => {
    const d = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } });
    expect(claudeStreamText(d)).toEqual({ delta: "Hi" });
    expect(claudeStreamText(JSON.stringify({ type: "result", result: "Whole" }))).toEqual({ result: "Whole" });
    expect(claudeStreamText(JSON.stringify({ type: "result", result: "x", is_error: true }))).toBeNull();
    expect(claudeStreamText("not json")).toBeNull();
    expect(claudeStreamText(JSON.stringify({ type: "system" }))).toBeNull();
  });
  it("reads SSE deltas", () => {
    expect(sseDelta('data: {"choices":[{"delta":{"content":"ab"}}]}')).toBe("ab");
    expect(sseDelta('data: {"choices":[{"delta":{}}]}')).toBe("");
    expect(sseDelta(": keepalive")).toBe("");
    expect(sseDelta("data: [DONE]")).toBeNull();
  });
});

describe("mp3 joining", () => {
  it("strips an ID3 tag and a Xing header frame, keeps the audio frames", () => {
    const frame = fakeMp3(1);
    const xing = Buffer.from(frame);
    xing.write("Xing", 36, "latin1");
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const out = stripMp3Meta(Buffer.concat([id3, xing, fakeMp3(3)]));
    expect(out.length).toBe(417 * 3);
    expect(mp3Format(out)).toBe("44100Hz 128kbps 2ch");
  });
  it("leaves a plain stream alone", () => {
    expect(stripMp3Meta(fakeMp3(2)).length).toBe(834);
  });
});
