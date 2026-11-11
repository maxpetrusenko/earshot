---
name: earshot
description: Turn a finished task's result into a short spoken memo with a sketch, and end the reply with one line of two tappable Listen links (edited and original). Use at the end of a substantial task (several tool calls: edits, test runs, a deploy, a research pass, a PR) or when the user says "narrate", "listen" or "voice memo". Do not use for greetings, quick answers, single lookups, clarifying questions, or any turn with no tool use or under about 400 characters of result.
allowed-tools: Bash({{EARSHOT}} run *)
---
<!-- earshot-managed -->

# earshot

Give the user two memos they can listen to: the edited one and the original, both for the reply you are about to send.

## When

Run this once, at the very end of a turn that did real work, or when the user says "narrate", "listen" or "voice memo". Skip it for a short answer or a turn that used no tools unless they asked. Never run it twice for one reply.

## Steps

1. Write your final reply for this turn, the exact text the user will read. Do not write a second text for narration.
2. Pass that reply to earshot word for word. It is not a summary, not a rewrite, not an earlier reply and not text from another task. Use only this turn's final reply. Put it in the heredoc body unchanged:

```bash
{{EARSHOT}} run --detach --from claude-code --session "${CLAUDE_SESSION_ID}" <<'EARSHOT_EOF'
<your final reply, exactly as you will send it>
EARSHOT_EOF
```

3. The command prints one markdown line at once, like `[Listen](<url>) · [Listen original](<url>)`. Each link starts playing when tapped. Copy the line verbatim.
4. Send your final reply, unchanged. Make the last line of the message exactly that markdown line, with nothing after it. Do not add the card link or any other link, and do not turn the links into raw URLs.

If the command fails or prints no `[Listen](` line, say so in one sentence and do not invent a link.
