export type ScriptStyle = "story" | "brief";

/** Prompt file and version label per style. story is prompt v1, brief is the original v0. */
export const PROMPTS: Record<ScriptStyle, { file: string; version: string }> = {
  story: { file: "ear-script.v1.txt", version: "ear-script.v1" },
  brief: { file: "ear-script.v0.txt", version: "ear-script.v0" },
};

export const PROMPT_VERSION = PROMPTS.story.version;
