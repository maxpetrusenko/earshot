export type ScriptStyle = "short" | "story" | "brief";

/** Prompt file and version label per style. short is prompt v2 (the default), story is v1, brief is the original v0. */
export const PROMPTS: Record<ScriptStyle, { file: string; version: string }> = {
  short: { file: "ear-script.v2.txt", version: "ear-script.v2" },
  story: { file: "ear-script.v1.txt", version: "ear-script.v1" },
  brief: { file: "ear-script.v0.txt", version: "ear-script.v0" },
};

export const DEFAULT_STYLE: ScriptStyle = "short";
export const PROMPT_VERSION = PROMPTS[DEFAULT_STYLE].version;

/** short is a 20 to 40 second summary: hard cap, enforced in code by cutting at a sentence boundary. */
export const SHORT_MAX_WORDS = 110;
