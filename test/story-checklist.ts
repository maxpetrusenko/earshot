/** Quality checklist for the story style: conversational opener, named actors, verbatim quote, ends with asks. */

export const QUOTE = "my agent finishes a task while i'm driving. earshot turns the output into a 40-70 s voice memo and drops a Listen link in the chat, about 14 s later. github.com/example/earshot";

export function checkStory(script: string, quote: string = QUOTE): string[] {
  const problems: string[] = [];
  const text = script.trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (!/^(?:hey|hi|quick update|good (?:morning|evening))\b/i.test(text)) problems.push("opener: does not address the listener (Hey, / Quick update,)");
  if ((sentences[0] ?? "").split(/\s+/).length > 22) problems.push("opener: the first sentence is too long to start speaking fast");
  if (!/\bworker (?:one|1|two|2)\b/i.test(text)) problems.push("actors: no named worker (Worker one, Worker two)");
  if (!/\b(?:two|2) (?:things|workers|jobs|tasks)\b/i.test(text)) problems.push("count: the count is not said first");
  if (!text.includes(`"${quote}"`)) problems.push("quote: the post text is not read word for word inside quotes");
  const tail = sentences.slice(-3).join(" ");
  if (!/\?|\bfrom you\b|\bi need\b|\byou need to\b/i.test(tail) || !/\b(?:pick|choose|say|run|decide|tell)\b/i.test(tail)) problems.push("asks: does not end with what the listener must do");
  if (/\b(?:src|dist)\/|\.(?:ts|js|json)\b|https?:\/\/|`/.test(text)) problems.push("leaks: a path, file name, url or backtick");
  return problems;
}

export const STORY_SAMPLE = {
  quote: QUOTE,
  script:
    `Hey, two workers are running, and the post media tool is now the default. Worker one is building slice five of earshot. It makes the public repo your only working copy, and it gives you two buttons, play original and play edited, so you hear something in about three seconds. ` +
    `Worker two is building the post media tool, which makes your launch video from a short file. ` +
    `Here's the text for the post: "${QUOTE}" That is the version I recommend. ` +
    `From you I need three things: pick the angle for the post, say post for LinkedIn, and run the npm login and publish.`,
};
