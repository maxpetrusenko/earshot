---
name: earshot
description: Turn a finished task's result into a short spoken memo with a sketch, and print a Listen link as the last line of the reply. Use at the end of a substantial task (several tool calls: edits, test runs, a deploy, a research pass, a PR) or when the user says "narrate", "listen" or "voice memo". Do not use for greetings, quick answers, single lookups, clarifying questions, or any turn with no tool use or under about 400 characters of result.
allowed-tools: Bash({{EARSHOT}} run *)
---
<!-- earshot-managed -->

# earshot

You finished a task. Give the user a memo they can listen to on their phone.

## When

Run this once, at the very end of a task that did real work. Skip it for a short answer or a turn that used no tools. If the user asked for "narrate" or "listen", run it even for a small task. Never run it twice for one task.

## Steps

1. Write the wrap-up you are about to give the user, as plain prose of 100 to 400 words: what you did, the result, anything that failed or that you could not verify, and the next step or the one decision you need from them. Facts only, taken from this session. No secrets, tokens or credentials.
2. Pipe it in with exactly this command, with the wrap-up as the heredoc body:

```bash
{{EARSHOT}} run --detach --from claude-code --session "${CLAUDE_SESSION_ID}" <<'EARSHOT_EOF'
<the wrap-up>
EARSHOT_EOF
```

3. The command prints one line: `Listen: <url>`. Copy that line verbatim.
4. Give your normal final reply. Make the last line of that reply exactly the `Listen: <url>` line, with nothing after it.

If the command fails or prints no `Listen:` line, say so in one sentence and do not invent a link.
