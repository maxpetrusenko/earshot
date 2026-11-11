# Demo video

Built with [HyperFrames](https://github.com/heygen-com/hyperframes) 0.9.31 (Apache-2.0), installed project-local in this folder.

```bash
cd video
npm install
node src/build.mjs [briefId]      # needs a ready brief in ~/.earshot/briefs/<id>/
cd build/landscape && npx hyperframes render -o ../../out/earshot-demo-1920x1080.mp4
cd ../vertical    && npx hyperframes render -o ../../out/earshot-demo-1080x1350.mp4
```

`src/template.html` holds both layouts (`.L` and `.V`). The phone screen reuses `assets/card.css` and the card markup, and plays a real `memo.mp3`. `src/shots.mjs` takes the 390 px and 1080 px Playwright screenshots of a served card. Nothing here needs a GPU model or a download beyond Chrome and ffmpeg. `video/out/*.mp4` is not committed.
