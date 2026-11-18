# Style references

Four reference images from Max, each paired with the reply text it explains. They are the style bar for the explain stage and the scorer (`scripts/explain-score.ts` opens them before grading). Two are dark or from another tool; earshot ships light only, so those two set layout, not colour.

Max rated the set 6.5/10 as references: readable, but they look like formatted summaries. Per image: gate log 6, Orca player 7, performance 6.5 (the architecture reference was not rated). The Orca waveform is the one that works, because you can see which state is playing before you read the label. The newer renders push that direction; see `integrations/claude-code/skills/explainer-visuals/references/references.md` for the pairs and the critique.

| Image | Kind | Input text | What it shows |
| --- | --- | --- | --- |
| [01-bugfix-log-comparison.png](01-bugfix-log-comparison.png) | bugfix, "show what looked wrong" | Gate threshold: there was no off-by-one. The message printed two decimals, so 0.549 showed as '0.55 needs 0.55'. It now prints three. | Eyebrow "EARSHOT / LOG COMPARISON", headline "The gate was right.", one-line subhead, a BEFORE card (red-tinted mono "0.55 needs 0.55") and an AFTER card (green-tinted mono "0.549 needs 0.550"), footer "Gate decision unchanged." |
| [02-orca-player-state-key.png](02-orca-player-state-key.png) | Orca player, "make waiting look different from playing" | Player timeline colours: 'rest of Original' is grey, the same as 'waits for edited', so playing looks like waiting. Playing should be green. | A WAITING card with a dashed mark and a PLAYING card with a green waveform, no time axis because the reply gives no timings. Footer "State key only. No timing or alignment implied." Dark theme in the reference; rendered light in earshot. |
| [03-performance-range.png](03-performance-range.png) | performance, "show how long the listener waits" | Illustrative values: before about 60 s, after 7 to 11 s. | Eyebrow "EARSHOT / ILLUSTRATIVE DATA", headline "Original is ready sooner.", a stat chip "7-11 s after the change", one shared 0 to 60 s axis with Before as a dot at about 60 s and After as a range bar from 7 to 11 s. No invented average, no stage breakdown. |
| [04-architecture-layers.png](04-architecture-layers.png) | architecture, "recommendation" replies (dark, from another tool) | Architecture I recommend: independent AI agents (Hermes, Claude, CUA, Google SSO, Narrator) call a native macOS Input Service over CLI, MCP or a local socket. The service is a persistent Swift LaunchAgent with no Terminal windows. It splits into Mouse (move, click, drag), Keyboard (type, shortcuts) and Observe (AX, screenshot), all acting on the visible macOS desktop (Screen Sharing / VNC, native pointer events). | A stack of agents, then CLI / MCP / socket, then a native input service, splitting into Mouse / Keyboard / Observe, then the visible desktop, with icons and centered labels. |

## No-image example

Input: `Lint, typecheck, build and tests all pass (343 tests).`

Output: NO_IMAGE. A status line is a sentence; there is nothing to draw. Fixture: `test/fixtures/explain/status-tests.json`.
