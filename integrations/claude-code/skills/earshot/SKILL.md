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

   Do not decide about pictures and do not pass `--visual` or `--no-visual`. earshot decides from context, with no model call. It reads the user's latest message from this session's transcript (that is why `--from claude-code --session` is passed). If that message asks for a visual (visualize, diagram, chart, graph, draw, picture, image, "show me the architecture", flow, timeline, sketch), it always prints the Explain picture line, with the kind picked from your reply. If the user did not ask, a picture is made only for strong, specific evidence in the reply and only for a reply of about 1200 characters or more: a measured before and after with units ("1.8 s to 240 ms", "6.7 s → 0.6 s") or a table of measured numbers; a structure word (architecture, layer, boundary) next to a change verb (added, moved, replaced, split into) in one sentence; a named root cause followed by a named fix; or a status table whose rows are hosts or agents. Ordinary ops words (worker, service, queue, daemon, pipeline) and machine names alone score nothing. Without a request there is at most one automatic picture per session per 10 minutes and never on two replies in a row. Status updates, test, lint and build results, short answers and drafts get none. Only the user may force it with `--visual` or `--no-visual`.

3. The command returns in about half a second and the audio is made in the background. Outside Orca it prints one markdown line, like `[Listen](<url>) · [Original](<url>)`. Each link starts playing when tapped, even while the audio is still being made.
   Inside Orca (`ORCA_CHAT_SCRATCH_DIR` is set and writable) it prints `::orca-visual{file="earshot-<id>-player.html" title="Listen"}` (the Mac player; it renders nothing on iOS), then the markdown line for the phone. When the user asked for a picture, or the reply has strong evidence, it prints a second line, `::orca-visual{file="earshot-<id>-explain.html" title="Explain"}`, between the player line and the markdown line; the page starts as a placeholder and the worker replaces it with the model's image, or with a "what changed" card built from the reply's headings and bullets when the model draws nothing, so the line is never an empty card. It is always one line: when the model draws two or three visuals, that one page shows them stacked. The player page says it is preparing until the audio is ready, a few seconds later.
   Copy what it prints verbatim. Do not wait for the audio and do not run anything else to check on it.
4. Send your final reply, unchanged. Make the last lines of the message exactly what the command printed, with nothing after them: the single markdown line, or in Orca each `::orca-visual` line (player, then Explain when printed; this is the same in Claude Code, Codex and Cursor sessions running in Orca) on its own line (outside any code block) followed by the markdown line, kept in that order. Do not add the card link or any other link, and do not turn the links into raw URLs.

If the command fails or prints no `[Listen](` line, say so in one sentence and do not invent a link.
