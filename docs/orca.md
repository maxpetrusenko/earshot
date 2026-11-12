# Orca inline player

Read when: you run Claude Code inside Orca and want to tap Play in the chat instead of opening a link.

Orca's native chat renders an HTML page inline when a reply has `::orca-visual{file="<name>.html" title="..."}` on its own line, with the file in `$ORCA_CHAT_SCRATCH_DIR`. earshot writes that page. The top shows the memo title and its sketch. The bottom is a compact bar: Play and Original (one track at a time, resume from the paused offset), a seek bar, back and forward 10 s, a speed button cycling 1x, 1.25x, 1.5x and 2x, and elapsed / total time. Space toggles play and pause when the frame has focus. Errors show in the status line under the bar.

## Status

| Surface | What works |
|---|---|
| Orca desktop (Mac) | the inline player, confirmed 2026-11-12 |
| Orca iOS | inline visuals are not tappable; use the markdown links |

In Orca the skill prints two lines: the `::orca-visual` line for the Mac, then `[Listen](...) · [Original](...)` for the phone. Outside Orca it prints only the markdown line.

## Why Web Audio

Orca's content security policy blocks `data:` URLs for media, so `<audio src="data:audio/mpeg;base64,...">` fails with `NotSupportedError`. The page cannot fetch the audio either, because it has no network access. It embeds the MP3 as base64 text, decodes it with `AudioContext.decodeAudioData`, and plays it through an `AudioBufferSourceNode`. Seek, skip and speed changes stop the source and start a new one at the new offset, so the position is `offset + (context time - start time) * rate` at every speed.

## Use

```bash
echo "<agent reply>" | earshot run --format auto
```

`--format auto` picks the Orca output when `ORCA_CHAT_SCRATCH_DIR` is set and writable, and otherwise prints the links at once and finishes the memo in the background. `--format orca` forces the Orca output and falls back to the markdown line when the page cannot be made. `--orca-dir <path>` overrides the scratch directory. Orca output waits for the finished audio, so it cannot be combined with `--detach`.

The Stop hook treats either line as already narrated.

## Page size

The page embeds both tracks, re-encoded with ffmpeg to mono, 22.05 kHz MP3, plus the sketch. earshot predicts the size from the track durations, picks 24k, 20k or 16k, and encodes once. Budget is 480 KB (Orca's limit is 512 KB). If 16k still does not fit, the original track is dropped and the page says so. The file is `earshot-<brief id>.html`; each page needs a new file name.

## Speed

Inline mode waits for the whole audio, so the time to the line is the time to finish both tracks. Kokoro-FastAPI handles one request at a time, so two tracks on one server take the sum of their audio. In `inline` mode earshot sends every chunk at once and writes them in order, and `tts.original_base_url` can point the original track at a second Kokoro instance so the tracks stop competing:

```bash
# on the TTS host: a second instance on another port
uvicorn api.src.main:app --host <addr> --port 8883
```

```yaml
tts:
  original_base_url: http://<addr>:8883/v1
```

Measured on a 1.2 KB reply (Claude `sonnet` script, Kokoro on a 10-core Mac mini):

| Setup | Time to the `::orca-visual` line |
|---|---|
| inline, one Kokoro, chunks in sequence | 33 s |
| inline, one Kokoro, chunks in parallel | 24 s |
| inline, two Kokoro instances, one encode | 17 s |
| stream | 0.03 s |

The script from the model takes about 6 s of that; the rest is speech synthesis.

## Limits

- Not verified: whether Orca re-renders a file in place when it is rewritten. Each page needs a new file name.
- The page uses Orca theme tokens with fallbacks; it never redefines a token and avoids `100vh`.
