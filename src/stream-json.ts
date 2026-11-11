/**
 * Incremental reader for the ear-script JSON object: {"title": "...", "script": "...", ...}.
 * Text arrives in arbitrary pieces. String values are decoded as they stream, so the script can be spoken
 * before the model has finished the object. Anything that is not a string value at the top level is skipped.
 */
export interface FieldHandlers {
  /** A decoded piece of a string value, as it arrives. */
  delta?: (key: string, text: string) => void;
  /** A string value, complete. */
  field?: (key: string, value: string) => void;
}

type State = "seek" | "key" | "keyEnd" | "colon" | "value" | "string" | "skip";

const SIMPLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", '"': '"', "\\": "\\" };

export class JsonFieldStream {
  private state: State = "seek";
  private key = "";
  private value = "";
  private esc = false;
  private uni: string | null = null;
  private depth = 0;
  private skipStr = false;
  private skipEsc = false;
  /** Everything fed so far (for a fallback parse when no field was seen). */
  raw = "";
  fields = 0;

  constructor(private readonly h: FieldHandlers) {}

  push(chunk: string): void {
    this.raw += chunk;
    let pending = "";
    const flushDelta = () => {
      if (pending) this.h.delta?.(this.key, pending);
      pending = "";
    };
    for (const c of chunk) {
      switch (this.state) {
        case "seek":
          if (c === "{") this.state = "keyEnd";
          break;
        case "keyEnd": // between members: wait for a key quote
          if (c === '"') {
            this.key = "";
            this.state = "key";
            this.esc = false;
          }
          break;
        case "key":
          if (this.esc) {
            this.key += SIMPLE[c] ?? c;
            this.esc = false;
          } else if (c === "\\") this.esc = true;
          else if (c === '"') this.state = "colon";
          else this.key += c;
          break;
        case "colon":
          if (c === ":") this.state = "value";
          break;
        case "value":
          if (c === '"') {
            this.value = "";
            this.state = "string";
            this.esc = false;
            this.uni = null;
          } else if (!/\s/.test(c)) {
            this.state = "skip";
            this.depth = c === "{" || c === "[" ? 1 : 0;
            this.skipStr = false;
            this.skipEsc = false;
          }
          break;
        case "string": {
          let out: string | null = null;
          if (this.uni !== null) {
            this.uni += c;
            if (this.uni.length === 4) {
              out = String.fromCharCode(parseInt(this.uni, 16) || 0xfffd);
              this.uni = null;
            }
          } else if (this.esc) {
            this.esc = false;
            if (c === "u") this.uni = "";
            else out = SIMPLE[c] ?? c;
          } else if (c === "\\") this.esc = true;
          else if (c === '"') {
            flushDelta();
            this.fields++;
            this.h.field?.(this.key, this.value);
            this.state = "keyEnd";
          } else out = c;
          if (out !== null) {
            this.value += out;
            pending += out;
          }
          break;
        }
        case "skip":
          if (this.skipStr) {
            if (this.skipEsc) this.skipEsc = false;
            else if (c === "\\") this.skipEsc = true;
            else if (c === '"') this.skipStr = false;
          } else if (c === '"') this.skipStr = true;
          else if (c === "{" || c === "[") this.depth++;
          else if (c === "}" || c === "]") {
            if (this.depth === 0) this.state = "seek";
            else this.depth--;
          } else if (c === "," && this.depth === 0) this.state = "keyEnd";
          break;
      }
    }
    flushDelta();
  }
}
