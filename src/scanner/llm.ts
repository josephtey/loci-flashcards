import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';
import type { Effort } from '../lib/prompt-store';

/**
 * One model call, either provider.
 *
 * The extraction pipeline used to talk to Anthropic directly. It now goes through here so the
 * same four stages can run against a local Ollama instead — the nightly scan is where nearly all
 * the token spend in this project lives, and being able to run it for nothing is worth the
 * indirection even if the quality is not always good enough to keep.
 *
 * Both providers are asked for the same thing: fill in this Zod schema. Anthropic does it with
 * `output_config.format`, Ollama by compiling the JSON Schema into a decoding grammar. Zod
 * validates whatever comes back either way, so a provider that drifts is caught here rather than
 * three stages later when a card looks wrong.
 */

export type Provider = 'anthropic' | 'ollama';

/**
 * Which provider a model name belongs to.
 *
 * Derived from the name rather than passed alongside it, so a model and its provider cannot
 * disagree. Every Anthropic model is `claude-*`; every Ollama tag has a `:` or is a bare name
 * like `gpt-oss`. Deriving it also means a mixed run — Sonnet for the judgement stages, a local
 * model for the dedup check — needs no extra plumbing.
 */
export function providerOf(model: string): Provider {
  return model.startsWith('claude-') ? 'anthropic' : 'ollama';
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface CompleteOpts {
  /** Named in errors, so a failure says which stage produced it. */
  stage: string;
  model: string;
  system: string;
  user: string;
  schema: z.ZodType;
  maxTokens: number;
  /** Anthropic only. Ollama has no equivalent and ignores it. */
  effort?: Effort;
  /** Anthropic adaptive thinking. Off for the dedup check, which is a binary comparison. */
  think?: boolean;
  /** Ollama only: the largest context to allocate. See `numCtx`. */
  contextLimit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

/**
 * Every Anthropic call streams.
 *
 * The SDK refuses a non-streaming request whose `max_tokens` implies it could run past ten
 * minutes, and a batched stage-2 call over five targets — adaptive thinking plus fifteen
 * candidates with justifications — is comfortably in that range. `finalMessage()` still carries
 * `parsed_output`, so structured outputs work exactly as before; only the transport changes.
 */
async function callAnthropic<T>(o: CompleteOpts): Promise<{ parsed: T | null; usage: Usage }> {
  const stream = anthropic().messages.stream({
    model: o.model,
    max_tokens: o.maxTokens,
    ...(o.think === false ? {} : { thinking: { type: 'adaptive' as const } }),
    output_config: {
      ...(o.effort ? { effort: o.effort } : {}),
      format: zodOutputFormat(o.schema as never),
    },
    // The principles document rides on every call and is ~8k tokens. Caching the system block is
    // what keeps a multi-note run from paying for it repeatedly.
    system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: o.user }],
  });
  const message = await stream.finalMessage();

  // Truncation must never look like an empty answer. `max_tokens` covers thinking as well as
  // the response, so a model that thinks hard can exhaust the budget mid-JSON and come back with
  // nothing parseable — which, silently swallowed, reads as "this note had nothing worth
  // carding" while having cost a full call.
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `${o.stage}: hit max_tokens (${o.maxTokens}) before finishing — ` +
        `${message.usage.output_tokens} output tokens spent, mostly on thinking. ` +
        `Raise max_tokens or lower output_config.effort.`,
    );
  }
  if (message.stop_reason === 'refusal') {
    throw new Error(`${o.stage}: refused (${message.stop_details?.category ?? 'unknown'})`);
  }

  return { parsed: (message.parsed_output ?? null) as T | null, usage: message.usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL = 'http://127.0.0.1:11434';

function host(): string {
  return (process.env.OLLAMA_HOST || LOCAL).replace(/\/+$/, '');
}

function isLocalHost(): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(host());
}

function ollamaHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY;
  // The key belongs to ollama.com and only ever goes there.
  return {
    'content-type': 'application/json',
    ...(key && !isLocalHost() ? { authorization: `Bearer ${key}` } : {}),
  };
}

/** Rough token count. Deliberately pessimistic — undercounting here causes silent truncation. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * How much context to allocate, and when to refuse instead.
 *
 * This is the single most important line in the Ollama path. Ollama's default context is 4096
 * tokens and **overflow is discarded silently, from the front** — a 10k-token stage-1 prompt gets
 * its system prompt and the top of the note thrown away, and the model then answers confidently
 * from the fragment that survived. Measured directly: a 10k-token prompt with a fact planted at
 * the start reported `prompt_eval_count: 2050` and invented an answer; the same prompt at
 * `num_ctx: 32768` reported 9936 and answered correctly.
 *
 * So the context is sized from the actual prompt every call. And when the prompt genuinely does
 * not fit, this throws rather than letting the request through — a note that was silently read
 * from the middle would produce plausible cards drawn from a fraction of the source, which is
 * worse than a run that stops and says so.
 */
function numCtx(prompt: string, limit: number, stage: string): number {
  // Headroom for the generated answer as well as the prompt: `num_ctx` covers both.
  const needed = estimateTokens(prompt) + 2048;
  if (needed > limit) {
    throw new Error(
      `${stage}: prompt needs about ${needed} tokens of context but the limit is ${limit}. ` +
        `Ollama would silently drop the overflow and answer from the remainder. Raise ` +
        `ollamaContext, or lower wordsPerTarget / batchSize so less goes in one call.`,
    );
  }
  // Round up to a power of two: a KV cache sized to the exact prompt would be reallocated on
  // every call, and Ollama reloads the model when the context size changes.
  return Math.min(limit, Math.max(8192, 2 ** Math.ceil(Math.log2(needed))));
}

async function callOllama<T>(o: CompleteOpts): Promise<{ parsed: T | null; usage: Usage }> {
  const limit = o.contextLimit ?? 32768;
  const ctx = numCtx(o.system + o.user, limit, o.stage);

  // `io: 'output'` matters: on a schema with defaults or transforms the input and output shapes
  // differ, and the model is filling in the output side.
  const format = z.toJSONSchema(o.schema, { io: 'output' });

  const res = await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders(),
    // Extraction calls are long — a stage-2 batch on a local model runs into minutes, and a
    // timeout here throws away work that was nearly done.
    signal: AbortSignal.timeout(isLocalHost() ? 600_000 : 300_000),
    body: JSON.stringify({
      model: o.model,
      stream: false,
      // gpt-oss ignores the boolean and wants a level; everything else takes `false`. Thinking is
      // off because the prompts already make each stage justify itself in-band — a `rationale` or
      // `justification` field is reasoning we get to keep and read, unlike thinking tokens.
      think: o.model.startsWith('gpt-oss') ? 'low' : false,
      keep_alive: '30m',
      format,
      options: {
        num_ctx: ctx,
        num_predict: o.maxTokens,
        // Extraction is not a task where sampling variety helps; a low temperature keeps a
        // re-run over the same note from producing a different deck.
        temperature: 0.2,
      },
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let reason: string | null = null;
    try {
      reason = (JSON.parse(detail) as { error?: string }).error ?? null;
    } catch {
      reason = null;
    }
    throw new Error(`${o.stage}: ${reason || `Ollama answered ${res.status}`}`);
  }

  const body = (await res.json()) as {
    message?: { content?: string };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (body.error) throw new Error(`${o.stage}: ${body.error}`);

  const content = body.message?.content ?? '';

  // Same trap as the Anthropic side: running out of output budget mid-JSON must not read as
  // "nothing worth carding here".
  if (body.done_reason === 'length') {
    throw new Error(
      `${o.stage}: hit num_predict (${o.maxTokens}) before finishing the JSON. ` +
        `Raise max_tokens for this stage, or lower batchSize.`,
    );
  }
  if (!content.trim()) {
    throw new Error(`${o.stage}: Ollama returned an empty response.`);
  }

  const usage: Usage = {
    input_tokens: body.prompt_eval_count ?? 0,
    output_tokens: body.eval_count ?? 0,
    // Ollama has no prompt cache to report. Left at zero rather than omitted so the caller's
    // arithmetic is identical for both providers.
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // A grammar-constrained model still gets the *semantics* wrong sometimes — a `target_index`
  // pointing at a target that was never sent, for instance. Zod is the backstop.
  const parsed = o.schema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(
      `${o.stage}: ${o.model} returned JSON that doesn't match the schema — ` +
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
    );
  }

  return { parsed: parsed.data as T, usage };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function complete<T>(o: CompleteOpts): Promise<{ parsed: T | null; usage: Usage }> {
  return providerOf(o.model) === 'ollama' ? callOllama<T>(o) : callAnthropic<T>(o);
}

/**
 * Is the configured Ollama reachable, with that model pulled?
 *
 * Checked before a run rather than discovered on the first note — a scan that dies four notes in
 * because the model was never pulled has already spent real time on the vault diff.
 */
export async function ollamaReady(model: string): Promise<{ ok: boolean; reason?: string }> {
  const at = host();
  let res: Response;
  try {
    res = await fetch(`${at}/api/tags`, {
      headers: ollamaHeaders(),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: `No Ollama at ${at}.` };
  }
  if (!res.ok) return { ok: false, reason: `${at} answered ${res.status}.` };

  const body = (await res.json()) as { models?: { name?: string }[] };
  const names = (body.models ?? []).map((m) => m.name ?? '');
  const wanted = model.includes(':') ? model : `${model}:latest`;
  if (!names.includes(model) && !names.includes(wanted)) {
    return {
      ok: false,
      reason: `${model} isn't available at ${at}${isLocalHost() ? ` — run \`ollama pull ${model}\`` : ''}.`,
    };
  }
  return { ok: true };
}
