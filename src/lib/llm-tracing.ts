import { Langfuse } from "langfuse";

/**
 * Langfuse wrapper. Every LLM call and TTS call goes through here.
 * No-op unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set.
 * Callers only ever hold already-redacted text, so traces carry no raw secrets.
 */

type TraceHandle = ReturnType<Langfuse["trace"]>;

let client: Langfuse | null | undefined;
let current: TraceHandle | null = null;

function getClient(): Langfuse | null {
  if (client !== undefined) return client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    client = null;
    return client;
  }
  client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || undefined,
  });
  return client;
}

export function tracingEnabled(): boolean {
  return getClient() !== null;
}

export function beginRun(id: string, metadata: Record<string, unknown>): void {
  const lf = getClient();
  current = lf ? lf.trace({ name: "earshot.run", id, metadata, tags: ["earshot"] }) : null;
}

export function endRun(output: Record<string, unknown>): void {
  current?.update({ output });
}

export interface GenerationMeta {
  model: string;
  input: string;
  metadata?: Record<string, unknown>;
}

/** Wrap one LLM generation. `describe` maps the result to the traced output string. */
export async function traceGeneration<T>(
  name: string,
  meta: GenerationMeta,
  fn: () => Promise<T>,
  describe: (r: T) => string = (r) => String(r),
): Promise<T> {
  const gen = current?.generation({ name, model: meta.model, input: meta.input, metadata: meta.metadata });
  try {
    const result = await fn();
    gen?.end({ output: describe(result) });
    return result;
  } catch (e) {
    gen?.end({ level: "ERROR", statusMessage: (e as Error).message });
    throw e;
  }
}

/** Wrap a non-LLM step (TTS, sketch render) as a span. */
export async function traceSpan<T>(
  name: string,
  meta: { input?: Record<string, unknown> },
  fn: () => Promise<T>,
  describe: (r: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const span = current?.span({ name, input: meta.input });
  try {
    const result = await fn();
    span?.end({ output: describe(result) });
    return result;
  } catch (e) {
    span?.end({ level: "ERROR", statusMessage: (e as Error).message });
    throw e;
  }
}

export async function flushTracing(): Promise<void> {
  if (client) await client.shutdownAsync().catch(() => undefined);
}
