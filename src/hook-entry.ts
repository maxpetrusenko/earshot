#!/usr/bin/env node
/** Hook entry point (Claude Code Stop hook, Codex notify). Keeps its imports small: it must exit within about 200 ms. */

async function readStdin(limit = 5 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    n += (c as Buffer).length;
    if (n > limit) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

let out: unknown = {};
if (process.argv[2] === "codex") {
  // Codex runs `<notify argv...> codex '<json>'`; nothing arrives on stdin.
  const { handleNotify, parseNotifyArgv } = await import("./hook/codex.js");
  const payload = parseNotifyArgv(process.argv.slice(3));
  const r = payload ? await handleNotify(payload) : {};
  out = r;
} else {
  const { handleStop } = await import("./hook/claude-code.js");
  let payload = {};
  try {
    payload = JSON.parse(await readStdin()) as object;
  } catch {
    /* an unreadable payload just means nothing to narrate */
  }
  out = await handleStop(payload);
}
process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
