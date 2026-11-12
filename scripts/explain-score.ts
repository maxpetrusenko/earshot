// Score explainer screenshots with Opus on the Claude subscription login, one image at a time.
// The image path goes into the prompt; Opus opens it with its Read tool and answers with strict JSON.
// Usage: pnpm tsx scripts/explain-score.ts <png|dir> [...more] [--model opus] [--json] [--min 8]
// Exits 2 when the Claude login is not usable (weekly limit, not logged in), so a loop can tell a real
// low score from a missing quota.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const minFlag = args.indexOf("--min");
const min = minFlag >= 0 ? Number(args[minFlag + 1]) : 0;
const modelFlag = args.indexOf("--model");
const model = modelFlag >= 0 ? args[modelFlag + 1]! : "opus";
const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min" && args[i - 1] !== "--model");

const images: string[] = [];
for (const p of inputs) {
  const full = resolve(p);
  if (existsSync(full) && statSync(full).isDirectory()) {
    for (const f of readdirSync(full).filter((f) => f.endsWith(".png")).sort()) images.push(join(full, f));
  } else images.push(full);
}
if (images.length === 0) {
  console.error("usage: explain-score <png|dir> [...] [--model opus] [--json] [--min 8]");
  process.exit(2);
}

/** Six areas of one image, 1 to 10, plus the overall verdict. */
interface Scores {
  file: string;
  realism: number;
  legibility: number;
  density: number;
  journey: number;
  metrics: number;
  style: number;
  overall: number;
  notes: string;
}

const AREAS = ["realism", "legibility", "density", "journey", "metrics", "style"] as const;

const PROMPT = (file: string) => `You are grading one screenshot of a visual explanation, as a hard-to-please design reviewer.

Open the image at ${file} with your Read tool. Judge only what the image shows, not any description.

Score each area from 1 to 10, where 8 means good enough to ship and 10 is exceptional:
- realism: does it show the real interface or data (windows, controls, bars, values), never a box labelled "Diagram"?
- legibility: is what changed outlined or pointed at with an arrow, and obvious in one glance?
- density: is the space used well at this width, or is it sparse, padded or full of sentences?
- journey: do the captions tell the reader what they can now do, rather than how the code works?
- metrics: are before and after numbers shown with an honest measured-versus-target note?
- style: light theme, a real typeface (not Inter/Roboto/Arial), no purple-on-white, no badges or chips, readable contrast, nothing clipped.

Then give overall as the honest verdict for shipping this image.

Return only this JSON object, no prose:
{"realism":0,"legibility":0,"density":0,"journey":0,"metrics":0,"style":0,"overall":0,"notes":"one sentence on the biggest weakness"}`;

function claude(args: string[], prompt: string): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k];
  env.PATH = `/opt/homebrew/bin:${join(homedir(), ".local", "bin")}:${env.PATH ?? ""}`;
  return new Promise((res) => {
    const child = spawn("claude", [...args, prompt], { env, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: 127, out: "", err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, out, err });
    });
  });
}

const firstJson = (raw: string): Record<string, unknown> | null => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

const scores: Scores[] = [];
for (const file of images) {
  process.stderr.write(`scoring ${file}\n`);
  const r = await claude(["-p", "--model", model], PROMPT(file));
  // Claude Code prints settings warnings to stderr on every run; they are not the answer.
  const text = `${r.out}\n${r.err}`.split("\n").filter((l) => !/^Permission allow rule|^Unknown env config|^\s*$/.test(l)).join("\n");
  const quota = /weekly limit|not logged in|invalid api key|Please run \/login/i;
  if (quota.test(text)) {
    const line = text.split("\n").find((l) => quota.test(l)) ?? "";
    console.error(`claude login not usable (${line.trim().slice(0, 160)})`);
    process.exit(2);
  }
  const o = firstJson(r.out);
  if (!o || Number.isNaN(n(o.overall))) {
    console.error(`no scores from opus for ${file} (exit ${r.code}): ${(r.out + r.err).trim().slice(0, 200)}`);
    process.exit(1);
  }
  const row: Scores = { file, realism: n(o.realism), legibility: n(o.legibility), density: n(o.density), journey: n(o.journey), metrics: n(o.metrics), style: n(o.style), overall: n(o.overall), notes: typeof o.notes === "string" ? o.notes : "" };
  scores.push(row);
  if (!json) process.stderr.write(`  overall ${row.overall}/10  ${row.notes}\n`);
}

const mean = (k: keyof Scores): number => scores.reduce((a, s) => a + (Number(s[k]) || 0), 0) / scores.length;
if (json) {
  console.log(JSON.stringify(scores, null, 2));
} else {
  const head = ["image", ...AREAS, "overall"].join("\t");
  console.log(head);
  for (const s of scores) console.log([s.file.split("/").pop(), ...AREAS.map((k) => s[k]), s.overall].join("\t"));
  console.log(["mean", ...AREAS.map((k) => mean(k).toFixed(1)), mean("overall").toFixed(1)].join("\t"));
}

const worst = Math.min(...scores.map((s) => s.overall));
if (min > 0 && worst < min) process.exit(1);
