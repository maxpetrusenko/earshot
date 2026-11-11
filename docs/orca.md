# Orca inline player

Read when: you run Claude Code inside Orca and want to tap Play in the chat instead of opening a link.

Orca's native chat renders an HTML page inline when a reply has `::orca-visual{file="<name>.html" title="..."}` on its own line, with the file in `$ORCA_CHAT_SCRATCH_DIR`. earshot writes that page: two big buttons, Play (the edited memo) and Original, a time readout, and only one track plays at a time.

## Status: opt-in, desktop only, unverified

Off by default. The skill and the Stop hook still produce the markdown Listen line. On an iPhone, Orca's inline visuals did not respond to taps: JS buttons did nothing and native `<audio controls>` showed no play button, for both the embedded and the streamed page. Desktop Orca playback has not been checked. Use the plain Listen links on mobile.

## Use

```bash
echo "<agent reply>" | earshot run --format orca
# ::orca-visual{file="earshot-<id>.html" title="Listen"}
```

Run it yourself, or write your own skill that calls it when `ORCA_CHAT_SCRATCH_DIR` is set. The Stop hook does nothing when the reply already has an earshot `::orca-visual` line.

`--orca-dir <path>` overrides the scratch directory. If it is unset or not writable, or the edited track fails, earshot prints the markdown Listen line instead.

## Two audio modes

`orca.audio` in the config, or `--orca-audio` per run:

| Mode | Page | Output line | Needs |
|---|---|---|---|
| `inline` (default) | audio embedded as `data:` URLs, under 480 KB | after both tracks are finished | nothing else, the page cannot make network requests |
| `stream` | audio elements point at the served MP3s, a few KB | at once, the memo is made in the background | `earshot serve` reachable from the device |

Inline pages are re-encoded with ffmpeg to mono, 22.05 kHz MP3. earshot predicts the page size from the track durations, picks 24k, 20k or 16k, and encodes once. If 16k still does not fit, the original track is dropped and the page says so. Orca's limit is 512 KB per page and a new file name each time; the file is `earshot-<brief id>.html`.

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

- Not verified: whether Orca re-renders a file in place when it is rewritten. Each page needs a new file name, so an "original first, edited later" update would need a second reply with a second file.
- The page cannot reach the network in `inline` mode and uses Orca theme tokens with fallbacks; it never redefines a token and avoids `100vh`.
