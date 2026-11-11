import { spawn } from "node:child_process";
import { netFetch } from "./lib/net.js";
import { resolveKey, type TtsConfig } from "./config.js";

export class TtsError extends Error {}

export interface TtsResult {
  audio: Buffer;
  duration_s: number | null;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Walk MPEG Layer III frames and sum their length. Returns null if no frames parse. */
export function mp3Duration(buf: Buffer): number | null {
  let i = 0;
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    i = 10 + (((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f));
  }
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (buf[i + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[i + 1]! >> 1) & 3; // 1 = Layer III
    const br = buf[i + 2]! >> 4;
    const sr = (buf[i + 2]! >> 2) & 3;
    const pad = (buf[i + 2]! >> 1) & 1;
    const rates = RATES[version];
    if (layer !== 1 || version === 1 || br === 0 || br === 15 || sr === 3 || !rates) {
      i++;
      continue;
    }
    const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[br]!;
    const rate = rates[sr]!;
    const samples = version === 3 ? 1152 : 576;
    const len = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
    seconds += samples / rate;
    frames++;
    i += len;
  }
  return frames > 0 ? Math.round(seconds * 10) / 10 : null;
}

interface FrameHeader {
  version: number;
  rate: number;
  kbps: number;
  channels: number;
  length: number;
}

/** Parse the MPEG Layer III frame header at offset i, or null when it is not one. */
function frameAt(buf: Buffer, i: number): FrameHeader | null {
  if (i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1]! >> 3) & 3;
  const layer = (buf[i + 1]! >> 1) & 3;
  const br = buf[i + 2]! >> 4;
  const sr = (buf[i + 2]! >> 2) & 3;
  const pad = (buf[i + 2]! >> 1) & 1;
  const rates = RATES[version];
  if (layer !== 1 || version === 1 || br === 0 || br === 15 || sr === 3 || !rates) return null;
  const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[br]!;
  const rate = rates[sr]!;
  const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
  return { version, rate, kbps, channels: (buf[i + 3]! >> 6) === 3 ? 1 : 2, length };
}

/** Sample rate, bitrate and channel count of the first frame, as one comparable string. */
export function mp3Format(buf: Buffer): string | null {
  const start = id3Length(buf);
  for (let i = start; i + 4 <= buf.length; i++) {
    const f = frameAt(buf, i);
    if (f) return `${f.rate}Hz ${f.kbps}kbps ${f.channels}ch`;
  }
  return null;
}

function id3Length(buf: Buffer): number {
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    return 10 + (((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f));
  }
  return 0;
}

/**
 * Raw audio frames only: the ID3 tag and the Xing/Info header frame are dropped, so chunks from separate
 * synthesis calls can be concatenated into one stream that decoders read as a single file.
 */
export function stripMp3Meta(buf: Buffer): Buffer {
  let i = id3Length(buf);
  while (i + 4 <= buf.length && !frameAt(buf, i)) i++;
  const f = frameAt(buf, i);
  if (f) {
    const head = buf.toString("latin1", i, Math.min(buf.length, i + 64));
    if (head.includes("Xing") || head.includes("Info")) i += f.length;
  }
  return buf.subarray(i);
}

/** Convert a WAV answer to MP3 with ffmpeg (a voice-clone server may ignore response_format). */
export function wavToMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "24000", "-b:a", "128k", "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new TtsError(`ffmpeg is needed to convert WAV from this tts server: ${e.message}`)));
    child.on("close", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new TtsError(`ffmpeg failed (${code}): ${err.slice(0, 160)}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(wav);
  });
}

export async function synthesize(cfg: TtsConfig, text: string, voice?: string): Promise<TtsResult> {
  const key = resolveKey(cfg.api_key_env);
  const url = `${cfg.base_url.replace(/\/$/, "")}/audio/speech`;
  const res = await netFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      input: text,
      voice: voice ?? cfg.voice,
      response_format: cfg.format,
      speed: cfg.speed,
    }),
    signal: AbortSignal.timeout(cfg.timeout_s * 1000),
  }).catch((e: Error) => {
    throw new TtsError(`tts request failed: ${e.message}`);
  });
  if (!res.ok) throw new TtsError(`tts HTTP ${res.status}`);
  let audio: Buffer = Buffer.from(await res.arrayBuffer());
  if (audio.toString("latin1", 0, 4) === "RIFF") audio = await wavToMp3(audio);
  if (audio.length < 1000) throw new TtsError(`tts returned only ${audio.length} bytes`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/audio|octet-stream/i.test(type)) throw new TtsError(`tts returned content-type ${type}`);
  return { audio, duration_s: mp3Duration(audio) };
}
