---
name: earshot
description: Required final step on every reply. Before sending any reply to the user, invoke this skill to make a short spoken summary and end the reply with one line of two links, Listen and Original. Skip only a reply under about 80 characters, or a pure clarifying question under 80 characters.
allowed-tools: Bash({{EARSHOT}} run *)
---
<!-- earshot-managed -->

# earshot

Give the user two memos they can listen to for the reply you are about to send: Listen, a short spoken summary, and Original, the reply read aloud with code, paths and links left out.

## When

Run this once, at the very end of every reply to the user, tool use or not (a required final step, not optional). Skip it only for a reply under about 80 characters, or a pure clarifying question that is also under 80 characters. Never run it twice for one reply.

## Steps

1. Write your final reply for this turn, the exact text the user will read. Do not write a second text for narration.
2. Pass that reply to earshot word for word. It is not a summary, not a rewrite, not an earlier reply and not text from another task. Use only this turn's final reply. Put it in the heredoc body unchanged:

```bash
{{EARSHOT}} run --format auto --from claude-code --session "${CLAUDE_SESSION_ID}" <<'EARSHOT_EOF'
<your final reply, exactly as you will send it>
EARSHOT_EOF
```

3. Outside Orca the command prints one markdown line at once, like `[Listen](<url>) · [Original](<url>)`. Each link starts playing when tapped.
   Inside Orca (`ORCA_CHAT_SCRATCH_DIR` is set and writable) it waits for the finished audio, about 10 seconds, and prints `::orca-visual{file="earshot-<id>-player.html" title="Listen"}` (the Mac player; it renders nothing on iOS), then, only when a picture helps, `::orca-visual{file="earshot-<id>-explain.html" title="Explain"}` (a visual explanation of what changed; it shows on iPhone too), then the markdown line for the phone.
   Copy what it prints verbatim.
4. Send your final reply, unchanged. Make the last lines of the message exactly what the command printed, with nothing after them: the single markdown line, or in Orca each `::orca-visual` line on its own line (outside any code block) followed by the markdown line, kept in that order. Do not add the card link or any other link, and do not turn the links into raw URLs.

If the command fails or prints no `[Listen](` line, say so in one sentence and do not invent a link.
