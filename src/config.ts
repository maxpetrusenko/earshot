import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export class ConfigError extends Error {}

export interface LlmConfig {
  type: "claude-cli" | "openai-compatible";
  model: string;
  timeout_s: number;
  /** claude-cli only: binary to run. */
  command: string;
  /** openai-compatible only. */
  base_url: string;
  api_key_env: string;
}

export interface TtsConfig {
  type: "openai-compatible";
  base_url: string;
  model: string;
  voice: string;
  format: "mp3";
  speed: number;
  api_key_env: string;
  timeout_s: number;
  /** The active profile name, or "" when none is set. Its values are already merged into this object. */
  profile: string;
  /** A second TTS server for the original track, so both tracks synthesize at once on servers that handle one request at a time. Empty: same server. */
  original_base_url: string;
}

/** A named set of tts overrides. `fast` is Kokoro, `max` a voice clone; tts.profile picks one. */
export type TtsProfile = Partial<Omit<TtsConfig, "type" | "format">>;

export interface ServeConfig {
  mode: "tailscale-serve" | "tailnet-ip" | "loopback";
  port: number;
  /** tailscale-serve: the HTTPS port tailscale listens on. */
  https_port: number;
}

export interface Config {
  llm: LlmConfig;
  tts: TtsConfig;
  image: { type: "mermaid" | "none"; renderer: "beautiful-mermaid"; theme: "paper" };
  serve: ServeConfig;
  privacy: { redact: boolean; max_input_chars: number; evidence_hosts: string[] };
  /** story: a conversational memo (prompt v1); brief: the terse v0 memo. */
  script: { style: "story" | "brief" };
  /** stream: the Orca page links the served MP3s (tiny page, needs the server reachable); inline: audio is embedded as data URLs. */
  orca: { audio: "stream" | "inline" };
  /** Which Stop events become a memo (hook mode). */
  trigger: { min_chars: number; require_tool_use: boolean; opt_in_tag: boolean };
}

export const DEFAULTS: Config = {
  llm: {
    type: "claude-cli",
    model: "sonnet",
    timeout_s: 90,
    command: "claude",
    base_url: "",
    api_key_env: "",
  },
  tts: {
    type: "openai-compatible",
    base_url: "http://localhost:8880/v1",
    model: "kokoro",
    voice: "af_heart",
    format: "mp3",
    speed: 1.0,
    api_key_env: "",
    timeout_s: 120,
    profile: "",
    original_base_url: "",
  },
  image: { type: "mermaid", renderer: "beautiful-mermaid", theme: "paper" },
  serve: { mode: "tailscale-serve", port: 7777, https_port: 443 },
  privacy: { redact: true, max_input_chars: 40000, evidence_hosts: [] },
  trigger: { min_chars: 400, require_tool_use: true, opt_in_tag: false },
  script: { style: "story" },
  orca: { audio: "inline" },
};

export function defaultConfigPath(): string {
  return process.env.EARSHOT_CONFIG ?? join(homedir(), ".config", "earshot", "config.yaml");
}

export function earshotHome(): string {
  return process.env.EARSHOT_HOME ?? join(homedir(), ".earshot");
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function section(root: Obj, key: string, allowed: string[]): Obj {
  const v = root[key];
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new ConfigError(`config: "${key}" must be a mapping`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new ConfigError(`config: unknown key "${key}.${k}"`);
  }
  return v;
}

function pick<T>(sec: Obj, path: string, key: string, fallback: T, check: (v: unknown) => boolean, want: string): T {
  const v = sec[key];
  if (v === undefined) return fallback;
  if (!check(v)) throw new ConfigError(`config: "${path}.${key}" must be ${want}`);
  return v as T;
}

const isStr = (v: unknown) => typeof v === "string";
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isBool = (v: unknown) => typeof v === "boolean";
const isNonNegInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isHostList = (v: unknown) =>
  Array.isArray(v) && v.every((h) => typeof h === "string" && /^[A-Za-z0-9.-]+$/.test(h) && h.includes("."));
const oneOf = (...xs: string[]) => (v: unknown) => typeof v === "string" && xs.includes(v);
const port = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;

const PROFILE_KEYS = ["base_url", "model", "voice", "speed", "api_key_env", "timeout_s"];

/** Merge tts.profiles[tts.profile] over the base tts values. An unknown profile name is an error. */
function applyTtsProfile(cfg: Config, profiles: unknown): void {
  if (profiles !== undefined && !isObj(profiles)) throw new ConfigError('config: "tts.profiles" must be a mapping');
  const name = cfg.tts.profile;
  if (!name) return;
  const p = (profiles as Obj | undefined)?.[name];
  if (p === undefined) throw new ConfigError(`config: tts.profile "${name}" is not in tts.profiles`);
  if (!isObj(p)) throw new ConfigError(`config: "tts.profiles.${name}" must be a mapping`);
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k)) throw new ConfigError(`config: unknown key "tts.profiles.${name}.${k}"`);
  const path = `tts.profiles.${name}`;
  const t = cfg.tts;
  t.base_url = pick(p, path, "base_url", t.base_url, isStr, "a string");
  t.model = pick(p, path, "model", t.model, isStr, "a string");
  t.voice = pick(p, path, "voice", t.voice, isStr, "a string");
  t.speed = pick(p, path, "speed", t.speed, isNum, "a positive number");
  t.api_key_env = pick(p, path, "api_key_env", t.api_key_env, isStr, "a string");
  t.timeout_s = pick(p, path, "timeout_s", t.timeout_s, isNum, "a positive number");
}

export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`config: invalid YAML (${(e as Error).message.split("\n")[0]})`);
  }
  if (!isObj(raw)) throw new ConfigError("config: top level must be a mapping");
  for (const k of Object.keys(raw)) {
    if (!["llm", "tts", "image", "serve", "privacy", "trigger", "script", "orca"].includes(k)) {
      throw new ConfigError(`config: unknown key "${k}"`);
    }
  }
  const d = DEFAULTS;
  const llm = section(raw, "llm", ["type", "model", "timeout_s", "command", "base_url", "api_key_env"]);
  const tts = section(raw, "tts", ["type", "base_url", "model", "voice", "format", "speed", "api_key_env", "timeout_s", "profile", "profiles", "original_base_url"]);
  const image = section(raw, "image", ["type", "renderer", "theme"]);
  const serve = section(raw, "serve", ["mode", "port", "https_port"]);
  const privacy = section(raw, "privacy", ["redact", "max_input_chars", "evidence_hosts"]);
  const trigger = section(raw, "trigger", ["min_chars", "require_tool_use", "opt_in_tag"]);
  const script = section(raw, "script", ["style"]);
  const orca = section(raw, "orca", ["audio"]);

  const cfg: Config = {
    llm: {
      type: pick(llm, "llm", "type", d.llm.type, oneOf("claude-cli", "openai-compatible"), "claude-cli or openai-compatible"),
      model: pick(llm, "llm", "model", d.llm.model, isStr, "a string"),
      timeout_s: pick(llm, "llm", "timeout_s", d.llm.timeout_s, isNum, "a positive number"),
      command: pick(llm, "llm", "command", d.llm.command, isStr, "a string"),
      base_url: pick(llm, "llm", "base_url", d.llm.base_url, isStr, "a string"),
      api_key_env: pick(llm, "llm", "api_key_env", d.llm.api_key_env, isStr, "a string"),
    },
    tts: {
      type: pick(tts, "tts", "type", d.tts.type, oneOf("openai-compatible"), "openai-compatible"),
      base_url: pick(tts, "tts", "base_url", d.tts.base_url, isStr, "a string"),
      model: pick(tts, "tts", "model", d.tts.model, isStr, "a string"),
      voice: pick(tts, "tts", "voice", d.tts.voice, isStr, "a string"),
      format: pick(tts, "tts", "format", d.tts.format, oneOf("mp3"), "mp3"),
      speed: pick(tts, "tts", "speed", d.tts.speed, isNum, "a positive number"),
      api_key_env: pick(tts, "tts", "api_key_env", d.tts.api_key_env, isStr, "a string"),
      timeout_s: pick(tts, "tts", "timeout_s", d.tts.timeout_s, isNum, "a positive number"),
      profile: pick(tts, "tts", "profile", d.tts.profile, isStr, "a string"),
      original_base_url: pick(tts, "tts", "original_base_url", d.tts.original_base_url, isStr, "a string"),
    },
    image: {
      type: pick(image, "image", "type", d.image.type, oneOf("mermaid", "none"), "mermaid or none"),
      renderer: pick(image, "image", "renderer", d.image.renderer, oneOf("beautiful-mermaid"), "beautiful-mermaid"),
      theme: pick(image, "image", "theme", d.image.theme, oneOf("paper"), "paper"),
    },
    serve: {
      mode: pick(serve, "serve", "mode", d.serve.mode, oneOf("tailscale-serve", "tailnet-ip", "loopback"), "tailscale-serve, tailnet-ip or loopback"),
      port: pick(serve, "serve", "port", d.serve.port, port, "a port number"),
      https_port: pick(serve, "serve", "https_port", d.serve.https_port, port, "a port number"),
    },
    privacy: {
      redact: pick(privacy, "privacy", "redact", d.privacy.redact, isBool, "true or false"),
      max_input_chars: pick(privacy, "privacy", "max_input_chars", d.privacy.max_input_chars, isNum, "a positive number"),
      evidence_hosts: pick(privacy, "privacy", "evidence_hosts", d.privacy.evidence_hosts, isHostList, "a list of host names"),
    },
    trigger: {
      min_chars: pick(trigger, "trigger", "min_chars", d.trigger.min_chars, isNonNegInt, "a non-negative integer"),
      require_tool_use: pick(trigger, "trigger", "require_tool_use", d.trigger.require_tool_use, isBool, "true or false"),
      opt_in_tag: pick(trigger, "trigger", "opt_in_tag", d.trigger.opt_in_tag, isBool, "true or false"),
    },
    script: { style: pick(script, "script", "style", d.script.style, oneOf("story", "brief"), "story or brief") },
    orca: { audio: pick(orca, "orca", "audio", d.orca.audio, oneOf("stream", "inline"), "stream or inline") },
  };
  applyTtsProfile(cfg, tts.profiles);
  if (cfg.llm.type === "openai-compatible" && !cfg.llm.base_url) {
    throw new ConfigError('config: "llm.base_url" is required for type openai-compatible');
  }
  return cfg;
}

export function loadConfig(path?: string): Config {
  const p = path ?? defaultConfigPath();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config: ${p} not found. Run: earshot init`);
    }
    throw e;
  }
  return parseConfig(text);
}

/** Resolve an api_key_env name to its value. Empty name means no key. A named but unset variable is an error. */
export function resolveKey(envName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!envName) return undefined;
  const v = env[envName];
  if (!v) throw new ConfigError(`config: environment variable ${envName} is not set`);
  return v;
}
