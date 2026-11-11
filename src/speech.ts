/** Pure text helpers for speech: numbers to words, sentence cutting, chunking, and the original-track cleanup. */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion", " trillion"];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const t = TENS[Math.floor(n / 10)]!;
    parts.push(n % 10 ? `${t}-${ONES[n % 10]}` : t);
  } else if (n > 0 || parts.length === 0) parts.push(ONES[n]!);
  return parts.join(" ");
}

/** A non-negative integer (up to 15 digits) as English words. Longer digit runs are read digit by digit. */
export function numberToWords(digits: string): string {
  const clean = digits.replace(/^0+(?=\d)/, "");
  if (clean.length > 15) return [...digits].map((d) => ONES[Number(d)]).join(" ");
  let n = Number(clean);
  if (n === 0) return "zero";
  const groups: string[] = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (g) groups.unshift(`${below1000(g)}${SCALES[i]}`);
  }
  return groups.join(" ");
}

const ORDINAL_SPECIAL: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

function ordinalWords(digits: string): string {
  const words = numberToWords(digits);
  const m = /^(.*?)([a-z]+)$/.exec(words.replace(/-/g, "- "));
  if (!m) return words;
  const last = m[2]!;
  const ord = ORDINAL_SPECIAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return `${m[1]!.replace(/- /g, "-")}${ord}`;
}

/** 1100 to 2099 read as a year: "twenty twenty-six". Other four digit numbers read as plain numbers. */
function yearWords(digits: string): string | null {
  const n = Number(digits);
  if (digits.length !== 4 || n < 1100 || n > 2099) return null;
  const hi = Number(digits.slice(0, 2));
  const lo = Number(digits.slice(2));
  if (n >= 2000 && n <= 2009) return null;
  const loWords = lo === 0 ? "hundred" : lo < 10 ? `oh ${ONES[lo]}` : numberToWords(String(lo));
  return `${numberToWords(String(hi))} ${loWords}`;
}

const NUMBER_RE = /(\$)?(\d[\d,]*)(?:\.(\d+))?(%|(?:st|nd|rd|th)\b)?/g;

/** Replace every digit run in plain text with words. Decimals, percents, dollars, ordinals and commas are handled. */
function spellPlain(text: string): string {
  return text.replace(NUMBER_RE, (_m, dollar: string | undefined, int: string, frac: string | undefined, suffix: string | undefined) => {
    const digits = int.replace(/,/g, "");
    if (suffix && suffix !== "%" && !frac) return ordinalWords(digits);
    let out = (!frac && !dollar && !suffix && !int.includes(",") && yearWords(digits)) || numberToWords(digits);
    if (frac) out += ` point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`;
    if (suffix === "%") out += " percent";
    if (dollar) out += frac ? " dollars" : Number(digits) === 1 ? " dollar" : " dollars";
    return out;
  });
}

export interface QuoteState {
  inQuote: boolean;
}

const QUOTE_CHARS = /["“”]/;

/**
 * Spell out digits in a spoken sentence, leaving quoted spans untouched (a verbatim quote is read as written).
 * `state` carries an open quote from one sentence to the next.
 */
export function spellDigits(text: string, state: QuoteState = { inQuote: false }): string {
  let out = "";
  let plain = "";
  const flush = () => {
    out += spellPlain(plain);
    plain = "";
  };
  for (const ch of text) {
    if (QUOTE_CHARS.test(ch)) {
      if (state.inQuote) out += plain;
      else flush();
      if (!state.inQuote) plain = "";
      else plain = "";
      out += ch;
      state.inQuote = !state.inQuote;
    } else plain += ch;
  }
  if (state.inQuote) out += plain;
  else flush();
  return out;
}

const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|dr|mr|mrs|ms|st|no|approx)\.$/i;

/**
 * Cuts a growing text into sentences. A boundary is . ! ? (plus closing quotes) followed by whitespace, or a
 * blank line. The last, unfinished sentence stays in the buffer until flush().
 */
export class SentenceSplitter {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    const re = /[.!?]+["”')\]]*\s+|\n{2,}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const head = this.buf.slice(last, m.index + m[0].trimEnd().length);
      if (ABBREV.test(head)) continue;
      const s = this.buf.slice(last, end).trim();
      if (s) out.push(s);
      last = end;
    }
    this.buf = this.buf.slice(last);
    return out;
  }

  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s ? [s] : [];
  }
}

export interface ChunkerOptions {
  /** The first chunk is emitted as soon as it has this many characters. */
  firstMin?: number;
  /** The second chunk gathers sentences up to this many characters: small, so it is ready before the first one has played out. */
  second?: number;
  /** Later chunks gather sentences up to this many characters. */
  target?: number;
}

/** Groups sentences into TTS chunks: a small first chunk for fast first audio, larger ones after. */
export class Chunker {
  private pending: string[] = [];
  private emitted = 0;
  private readonly firstMin: number;
  private readonly second: number;
  private readonly target: number;

  constructor(o: ChunkerOptions = {}) {
    this.firstMin = o.firstMin ?? 30;
    this.target = o.target ?? 280;
    this.second = Math.min(o.second ?? 140, this.target);
  }

  private take(): string {
    this.emitted++;
    const s = this.pending.join(" ");
    this.pending = [];
    return s;
  }

  push(sentence: string): string[] {
    this.pending.push(sentence);
    const len = this.pending.join(" ").length;
    const need = this.emitted === 0 ? this.firstMin : this.emitted === 1 ? this.second : this.target;
    return len >= need ? [this.take()] : [];
  }

  flush(): string[] {
    return this.pending.length ? [this.take()] : [];
  }
}

/** Sentences of an already complete text, grouped into chunks. */
export function chunkText(text: string, o: ChunkerOptions = {}): string[] {
  const split = new SentenceSplitter();
  const chunker = new Chunker(o);
  const out: string[] = [];
  for (const s of [...split.push(`${text}\n\n`), ...split.flush()]) out.push(...chunker.push(s));
  out.push(...chunker.flush());
  return out;
}

/** snake_case, kebab-case and camelCase to plain words. */
export function plainName(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const GENERIC_STEMS = new Set(["index", "main", "mod", "init", "readme", "app"]);

/** "src/billing/webhook.ts" becomes "the webhook file". */
export function spokenPath(path: string): string {
  const clean = path.replace(/[)\].,;:]+$/, "").replace(/^[~.]*\//, "");
  const parts = clean.split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? "";
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
  let name = plainName(stem);
  if (GENERIC_STEMS.has(stem.toLowerCase()) && parts.length > 1) name = plainName(parts[parts.length - 2]!);
  if (!name) return "a file";
  if (!ext) return `the ${name} folder`;
  return /^(?:md|txt|json|ya?ml|toml)$/.test(ext) ? `the ${name} file` : `the ${name} file`;
}

const PATH_RE = /(?:^|(?<=[\s(]))(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+(?:\.\w{1,6})?(?::\d+)?|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sql|json|md|ya?ml|toml|sh|rs|go|css|html|txt|mp3|svg)\b/g;

/**
 * The text of a report, made speakable with no LLM: code blocks, URLs, hashes and tables are dropped,
 * paths become short names, markup is stripped and every line becomes a sentence.
 */
export function speakableOriginal(text: string, maxChars = 9000): string {
  let t = text.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  t = t.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/|#)[^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/[^\s)>\]"']+/gi, "a link");
  t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    if (/\//.test(code) || /\.\w{1,6}$/.test(code)) return spokenPath(code);
    if (/^[\w.-]{1,40}$/.test(code)) return plainName(code);
    if (/^[\w-]+(?: --?[\w-]+| [\w-]+){0,2}$/.test(code) && code.length <= 30) return plainName(code);
    return "";
  });
  t = t.replace(PATH_RE, (p) => (/^\d/.test(p) || /^[A-Z][a-z]+\.[A-Za-z]+$/.test(p) ? p : spokenPath(p)));
  t = t.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, "");
  t = t.replace(/\b([A-Za-z]+(?:_[A-Za-z]+)+)\b/g, (m) => plainName(m));
  const lines: string[] = [];
  for (const raw of t.split("\n")) {
    let line = raw.trim();
    if (!line || /^[-=*_|:\s]+$/.test(line) || /^\|.*\|$/.test(line)) {
      if (!line) lines.push("");
      continue;
    }
    const heading = /^#{1,6}\s/.test(line);
    line = line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    line = line.replace(/\*\*|__|\*|~~/g, "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    lines.push(/[.!?:]["')”]?$/.test(line) ? line : heading || !/[,;]$/.test(line) ? `${line}.` : line);
  }
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/([.!?]) ?\./g, "$1").trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
    out = at > maxChars / 2 ? cut.slice(0, at + 1) : cut;
  }
  return out;
}
