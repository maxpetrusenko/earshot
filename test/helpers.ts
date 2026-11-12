import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** N frames of silent MPEG1 Layer III, 128 kbps, 44.1 kHz (417 bytes, 1152 samples each). */
export function fakeMp3(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

export const GOOD_SCRIPT = Array.from({ length: 130 }, (_, i) => (i % 9 === 8 ? "word." : "word")).join(" ");

export interface FakeOptions {
  /** Mermaid strings returned by successive chat calls (last one repeats). */
  mermaid?: string[];
  script?: string;
  title?: string;
  /** What the explain stage gets back: any value, JSON-encoded. Default is {"no_image": true}. */
  explain?: unknown;
  /** Delay chat answers (ms) so a test can interrupt a pending brief. */
  chatDelayMs?: number;
}

/** One process serving /chat/completions and /audio/speech, like a local gateway. */
export async function startFakeProvider(opts: FakeOptions = {}): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const mermaid = opts.mermaid ?? ["flowchart LR\n  A[Bug found] --> B[Fix made]\n  B -.-> C[Rows left]"];
  let chat = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "/v1/chat/completions" && opts.chatDelayMs) {
        setTimeout(() => res.end("{}"), opts.chatDelayMs);
      } else if (req.url === "/v1/chat/completions") {
        const sys = JSON.parse(body).messages[0].content as string;
        const content = sys.startsWith("You are a visual explanation designer")
          ? JSON.stringify("explain" in opts ? opts.explain : { no_image: true })
          : sys.startsWith("You repair Mermaid")
          ? JSON.stringify({ mermaid: "flowchart LR\n  A[Fixed] --> B[Diagram]\n  B --> C[Renders]" })
          : JSON.stringify({
              title: opts.title ?? "Fake title",
              script: opts.script ?? GOOD_SCRIPT,
              mermaid: mermaid[Math.min(chat++, mermaid.length - 1)],
              evidence: "",
            });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      } else if (req.url === "/v1/audio/speech") {
        res.setHeader("content-type", "audio/mpeg");
        res.end(fakeMp3(60));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}
