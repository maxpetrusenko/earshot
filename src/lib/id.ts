import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ID_RE = /^[A-Za-z0-9]{16}$/;

/** 16 base62 chars from the CSPRNG (rejection sampling, no modulo bias). */
export function newId(): string {
  let out = "";
  while (out.length < 16) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < 16) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}
