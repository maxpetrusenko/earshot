# earshot: end every reply with listen links

Required final step on every reply to the user, tool use or not. Skip only a reply under about 80 characters, or a pure clarifying question under 80 characters. Run it once per reply, never twice.

1. Write your final reply for this turn, the exact text the user will read.
2. Pass that reply to earshot word for word (not a summary, not an earlier reply). Put it in the heredoc body unchanged:

```bash
{{EARSHOT}} run --format auto <<'EARSHOT_EOF'
<your final reply, exactly as you will send it>
EARSHOT_EOF
```

   Do not decide about pictures and do not pass `--no-visual`. earshot decides from context (no model call). Pass `--visual` only when the user's own latest message asked for a visual (visualize, diagram, chart, graph, draw, picture, image, "show me the architecture", flow, timeline, sketch); that always prints an Explain picture. Without a request, earshot draws only for strong, specific evidence in a reply of about 1200 characters or more: a measured before and after with units or a table of measured numbers, a structure word (architecture, layer, boundary) with a change verb (added, moved, replaced, split into) in one sentence, a named root cause with a named fix, or a status table whose rows are hosts or agents. Ordinary ops words and machine names alone score nothing, and there is at most one automatic picture per session per 10 minutes. Status updates, test results, short answers and drafts get none.
3. The command returns in about half a second and prints one markdown line, `[Listen](<url>) · [Original](<url>)`. Inside Orca (Claude Code, Codex, Cursor or any agent Orca runs; `ORCA_CHAT_SCRATCH_DIR` is set) run it there too: it first prints the `::orca-visual{...}` player line and, when a picture was asked for or the reply has strong evidence, an Explain line. Copy what it printed verbatim. Do not wait for the audio and do not run anything else to check on it.
4. Send your final reply unchanged. The last lines of the message are exactly what the command printed, with nothing after them. Do not add any other link and do not turn the links into raw URLs.

If the command fails or prints no `[Listen](` line, say so in one sentence and do not invent a link.
