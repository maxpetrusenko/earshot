# One reply, end to end

One realistic agent reply, run through everything earshot makes: two audio
tracks, the spoken script, and the explainer pages. The reply is written for
this example; nothing in it is private.

| File | What it is |
| --- | --- |
| [reply.md](reply.md) | The agent reply, exactly as it would arrive |
| [script.md](script.md) | The edited memo script and why it is shaped that way |
| [listen.mp3](listen.mp3) | The edited memo, 28 s, 219 KB |
| [original.txt](original.txt) | The agent's own words, cleaned for reading aloud |
| [original.mp3](original.mp3) | The original track, 36 s, 249 KB |
| [explain/explain.html](explain/explain.html) | Explainer 1: the invoice page, before and after |
| [explain/explain2.html](explain/explain2.html) | Explainer 2: 201 round trips become one |
| [explain/spec.json](explain/spec.json) | The two visuals as data, the way the model returns them |

The explainer screenshots next to each page are 390 px and 1280 px wide, taken
with `fullPage` at `deviceScaleFactor: 2`: `explain-390.png`,
`explain-1280.png`, `explain2-390.png`, `explain2-1280.png`.

## Where the audio comes from

```
earshot run < reply.md
```

The edited track is the model's summary of the reply, read aloud. The original
track is the reply itself, with code fences, URLs and tables dropped. Both are
spoken by Kokoro (`af_heart`) and encoded down until the inline player page fits
its budget, which is why these files are 64 kbps and 56 kbps mono rather than
Kokoro's 128 kbps.

## Where the explainers come from

The explain stage asks for up to three visuals and returns JSON. To render a
saved answer without an LLM:

```
pnpm tsx scripts/explain-preview.ts examples/explain/spec.json examples/explain/explain --shots
```

That writes `explain.html` and `explain2.html` and their screenshots, and prints
each visual's type, its visual-content density and the gate result. Both pages
here pass the gate at 0.65 density: the first is a before/after of the invoice
page with the changed control outlined and annotated, the second a single
timeline drawing 1.8 s and 240 ms on one scale.

In a live run the CLI does the same thing by itself: it writes the pages beside
the player page and prints one Orca line per page, so Orca shows the player and
then each visual as its own block.
