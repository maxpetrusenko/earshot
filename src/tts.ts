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
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new TtsError(`tts returned only ${audio.length} bytes`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/audio|octet-stream/i.test(type)) throw new TtsError(`tts returned content-type ${type}`);
  return { audio, duration_s: mp3Duration(audio) };
}
