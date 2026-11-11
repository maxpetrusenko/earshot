// Generates build/landscape and build/vertical HyperFrames projects from src/template.html.
// Usage: node src/build.mjs [briefId]   (default: the brief used for the demo)
// Needs a ready brief in ~/.earshot/briefs/<id>/ (memo.mp3, sketch.svg) and `pnpm build` output not required.
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");
const brief = process.argv[2] ?? "aQfs3clsnLiyjl58";
const briefDir = join(homedir(), ".earshot", "briefs", brief);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Shared assets, copied into video/assets (gitignored).
mkdirSync(join(root, "assets/fonts"), { recursive: true });
copyFileSync(join(briefDir, "memo.mp3"), join(root, "assets/memo.mp3"));
copyFileSync(join(briefDir, "sketch.svg"), join(root, "assets/sketch.svg"));
copyFileSync(join(root, "node_modules/gsap/dist/gsap.min.js"), join(root, "assets/gsap.min.js"));
for (const f of ["newsreader-latin-500-normal.woff2", "source-sans-3-latin-400-normal.woff2", "source-sans-3-latin-600-normal.woff2"])
  copyFileSync(join(repo, "assets/fonts", f), join(root, "assets/fonts", f));
for (const f of ["ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono-latin-500-normal.woff2"])
  copyFileSync(join(root, "node_modules/@fontsource/ibm-plex-mono/files", f), join(root, "assets/fonts", f));

// The card stylesheet, scoped under .screen so it can live inside the video page.
function scopeCss(css) {
  if (/@media|@keyframes/.test(css)) throw new Error("card.css grew an at-rule; update scopeCss");
  const out = [];
  for (const chunk of css.split("}")) {
    if (!chunk.trim()) continue;
    const i = chunk.indexOf("{");
    const sel = chunk.slice(0, i).trim();
    const body = chunk.slice(i + 1);
    if (sel.startsWith("@font-face")) continue; // fonts are declared by the template
    if (sel === "html") continue;
    const scoped = sel
      .split(",")
      .map((s) => s.trim())
      .map((s) => (s === ":root" || s === "body" ? ".screen" : s === "*" ? ".screen *" : `.screen ${s}`))
      .join(", ");
    out.push(`${scoped} {${body}}`);
  }
  return out.join("\n");
}
const cardCss = scopeCss(readFileSync(join(repo, "assets/card.css"), "utf8"));

const wall = readFileSync(join(repo, "test/fixtures/outputs/08-long-multistep.txt"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => `<p class="wl" data-layout-allow-overlap>${esc(l)}</p>`)
  .join("\n");

const transcript = readFileSync(join(briefDir, "script.md"), "utf8").split("\n\n").slice(1).join(" ").trim();
const title = readFileSync(join(briefDir, "script.md"), "utf8").split("\n")[0].trim();
const template = readFileSync(join(here, "template.html"), "utf8");
const meta = JSON.parse(readFileSync(join(briefDir, "meta.json"), "utf8"));
const duration = meta.audio.duration_s;
const audioLen = Number(
  (await import("node:child_process")).execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(briefDir, "memo.mp3")]).toString().trim(),
);

for (const [name, W, H, cls] of [["landscape", 1920, 1080, "L"], ["vertical", 1080, 1350, "V"]]) {
  const dir = join(root, "build", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "assets"), join(dir, "assets"), { recursive: true, filter: (s) => !s.includes("/assets/shots") });
  writeFileSync(
    join(dir, "hyperframes.json"),
    JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2),
  );
  const html = template
    .replaceAll("@@W@@", String(W))
    .replaceAll("@@H@@", String(H))
    .replaceAll("@@CLS@@", cls)
    .replaceAll("@@AUDIO_LEN@@", String(audioLen))
    .replaceAll("@@AUDIO_SHOWN@@", `0:${String(Math.floor(audioLen)).padStart(2, "0")}`)
    .replaceAll("@@TITLE@@", esc(title))
    .replaceAll("@@TRANSCRIPT@@", esc(transcript).replaceAll("&#39;", "'"))
    .replaceAll("@@WALL@@", wall)
    .replaceAll("@@CARD_CSS@@", cardCss)
    .replaceAll("@@STAGE_ENGINE@@", String((meta.stages.find((s) => s.name === "ear-script").ms / 1000).toFixed(1)))
    .replaceAll("@@STAGE_TTS@@", String((meta.stages.find((s) => s.name === "tts").ms / 1000).toFixed(1)))
    .replaceAll("@@STAGE_TOTAL@@", String(Math.round(meta.total_ms / 1000)));
  writeFileSync(join(dir, "index.html"), html);
  console.log(`built ${dir} (audio ${audioLen}s, listed ${duration}s)`);
}
