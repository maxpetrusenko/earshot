/** Best-effort secret scrub. Runs before any network call. Not a guarantee. */

const MARK = "[REDACTED]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

const PATTERNS: RegExp[] = [
  PRIVATE_KEY_BLOCK,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
  /https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[A-Za-z0-9/_.-]+/gi,
  /\b0x[0-9a-fA-F]{64}\b/g,
];

// The lookbehind in ASSIGN anchors the greedy prefix to the start of a token. Without it every
// position in a long run like "a.a.a." re-scans to the end, which is quadratic.
const NAME =
  "[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential|private[_-]?key|[_-]key|x-amz-signature|(?<![a-z0-9])pass(?:phrase)?)s?";
const ASSIGN_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)`;

/** password=x, "token": "x", api_key: x, NAME_SECRET=x, in any case, with or without a prefix. */
const ASSIGN = new RegExp(String.raw`((?<![A-Za-z0-9_.-])(["']?)${NAME}\2\s*[:=]\s*)(${ASSIGN_VALUE})`, "gi");
/** Bare upper-case KEY=value (a lower-case "key" is too common in prose). */
const ASSIGN_BARE = new RegExp(String.raw`(\bKEY\s*[:=]\s*)(${ASSIGN_VALUE})`, "g");
/** ?key=, &sig=, ... in URLs. */
const QUERY = /([?&;](?:key|sig|signature|code|sas|auth|token|secret|password|pwd|x-amz-(?:signature|credential|security-token)|[a-z0-9_.-]*(?:token|secret|api[_-]?key|access[_-]?key|credential)s?)=)([^&\s#"'<>]+)/gi;
/** scheme://user:pw@host and scheme://token@host */
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi;
/** Cookie: and Set-Cookie: carry session ids; drop the whole value. */
const COOKIE = /(?<![A-Za-z0-9-])((?:set-)?cookie\s*:[ \t]*)[^\r\n]+/gi;
/** Authorization: Basic abc, Authorization: Digest ..., Proxy-Authorization too. */
const AUTH_HEADER = /\b((?:proxy-)?authorization\s*[:=]\s*(?:basic|bearer|digest|token|negotiate)?\s*)[A-Za-z0-9+/=._~-]{6,}/gi;

export interface RedactResult {
  text: string;
  count: number;
}

export function redact(input: string): RedactResult {
  let count = 0;
  let text = input;
  const sub = (re: RegExp, replace: (...g: string[]) => string) => {
    text = text.replace(re, (m, ...g: string[]) => {
      const out = replace(m, ...g);
      if (out !== m) count++;
      return out;
    });
  };
  for (const re of PATTERNS) sub(re, () => MARK);
  sub(USERINFO, (_m, scheme) => `${scheme}${MARK}@`);
  sub(COOKIE, (m, head) => (m.endsWith(MARK) ? m : `${head}${MARK}`));
  sub(AUTH_HEADER, (m, head) => (m.endsWith(MARK) ? m : `${head}${MARK}`));
  // Keep the variable name visible so the report still reads, drop the value.
  for (const re of [ASSIGN, ASSIGN_BARE]) {
    sub(re, (m, head, ...rest) => {
      const value = re === ASSIGN ? rest[1] : rest[0];
      return value === MARK ? m : `${head}${MARK}`;
    });
  }
  sub(QUERY, (m, head, value) => (value === MARK ? m : `${head}${MARK}`));
  return { text, count };
}
