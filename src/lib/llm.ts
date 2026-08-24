import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';
import type { Effort } from './prompt-store';

/**
 * Every model call in the project, either provider.
 *
 * There are exactly two backends and one switch between them. `claude` is Anthropic's API;
 * `ollama` is Ollama's hosted service, which here means one model — `gpt-oss:120b`, the largest
 * thing on their free tier that reliably fills in a schema.
 *
 * Running models on the laptop was the first version of this and it is gone. It was free and
 * private, but it made every path in the codebase conditional on which machine was running it:
 * a local Ollama truncates long prompts silently, needs its context sized per call, has to be
 * installed and pulled before anything works, and cannot be reached at all from a deployment.
 * The hosted service has none of those properties, so none of that code needs to exist.
 *
 * Both providers are asked for the same thing: fill in this Zod schema. Anthropic constrains
 * decoding to it; Ollama's hosted API does not (see `CONTRACT`), so it is told in words and the
 * reply is parsed leniently. Zod validates whatever comes back either way, so a provider that
 * drifts is caught at the call rather than three stages later when a card looks wrong.
 */

export type Provider = 'claude' | 'ollama';

/** Ollama's hosted API. There is no local option, so there is no host to configure. */
const OLLAMA_URL = 'https://ollama.com/api/chat';

/**
 * The only Ollama model this project uses.
 *
 * A constant rather than a setting: on the free tier it is the one model measured to do the job
 * (18/18 against the grading benchmark, where `nemotron-3-nano:30b` managed 13/18 and scored a
 * flatly wrong answer as correct). `OLLAMA_MODEL` overrides it if that ever stops being true.
 */
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || 'gpt-oss:120b';

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
  /** Anthropic adaptive thinking. Off for the cheap calls — dedup and grading. */
  think?: boolean;
}

/** Which backend a model name belongs to, so the two can never disagree. */
export function providerOf(model: string): Provider {
  return model.startsWith('claude-') ? 'claude' : 'ollama';
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
    // The principles document rides on every extraction call and is ~8k tokens. Caching the
    // system block is what keeps a multi-note run from paying for it repeatedly.
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
// Ollama (hosted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output contract, appended to the system prompt for Ollama only.
 *
 * `format` is sent as well, but ollama.com does not compile it into a decoding grammar the way a
 * local Ollama does — a schema-constrained request comes back as prose ("**Score: 1** – the
 * response does not…"), for flat schemas and nested ones alike. Saying it in words costs ~60
 * tokens and is the difference between this path working and not.
 *
 * It lives here rather than in any of the editable prompts because it is a fact about the
 * transport, not about the task.
 */
const CONTRACT = [
  '',
  '---',
  '',
  'Reply with a single JSON object and nothing else: no preamble, no explanation around it, no',
  'markdown code fence. It must match this JSON Schema exactly, including every required key:',
  '',
  '{{SCHEMA}}',
  '',
  'Numbers are bare numbers, not strings. Where the schema allows null, use null, not "null".',
].join('\n');

/**
 * Pull the object out of whatever came back.
 *
 * `JSON.parse` on the raw string is right when a grammar was enforced and wrong the moment it
 * was not — a fenced block or a sentence of preamble is enough to throw. Scanning for the first
 * balanced object handles both, and a reply with no object in it at all still fails, which is
 * what we want: the caller decides what to do about that, and never gets a guessed value.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to a scan.
  }

  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in the reply');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (c === '"') inString = !inString;
    else if (!inString && c === '{') depth++;
    else if (!inString && c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in the reply');
}

async function callOllama<T>(o: CompleteOpts): Promise<{ parsed: T | null; usage: Usage }> {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) {
    throw new Error(
      `${o.stage}: OLLAMA_API_KEY is not set. Get one at https://ollama.com/settings/keys.`,
    );
  }

  // `io: 'output'` matters: on a schema with defaults or transforms the input and output shapes
  // differ, and the model is filling in the output side.
  const format = z.toJSONSchema(o.schema, { io: 'output' });

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // A typical call returns in about a second, but a cold one has been measured at 42, and an
    // extraction batch is far larger than a grade. A timeout here throws away finished work.
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model: o.model,
      stream: false,
      // gpt-oss ignores `think: false` and wants a level; left at the default it spends the whole
      // token budget reasoning and returns empty content.
      think: 'low',
      format,
      options: {
        // Neither grading nor extraction is a task where sampling variety helps: the same input
        // should not produce a different deck on a re-run.
        temperature: 0,
        num_predict: o.maxTokens,
      },
      messages: [
        { role: 'system', content: o.system + CONTRACT.replace('{{SCHEMA}}', JSON.stringify(format)) },
        { role: 'user', content: o.user },
      ],
    }),
  });

  if (!res.ok) {
    // Ollama puts the useful part in the body — a model behind a subscription says so there, and
    // reporting "500" instead would send you looking in the wrong place.
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
  if (!content.trim()) throw new Error(`${o.stage}: Ollama returned an empty response.`);

  const usage: Usage = {
    input_tokens: body.prompt_eval_count ?? 0,
    output_tokens: body.eval_count ?? 0,
    // Nothing to report: the hosted service has no prompt cache and bills against a plan rather
    // than per token. Left at zero rather than omitted so the caller's arithmetic is identical.
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // Without an enforced grammar this is the only thing standing between a chatty model and a
  // deck full of malformed cards.
  let raw: unknown;
  try {
    raw = extractJson(content);
  } catch (err) {
    throw new Error(`${o.stage}: ${o.model} did not return JSON — ${(err as Error).message}`);
  }

  const parsed = o.schema.safeParse(raw);
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
 * Can the configured provider actually be reached?
 *
 * Checked before a scan starts and before the review screen offers the typing box, so a missing
 * key shows up as a sentence rather than as a stage that dies four notes in.
 */
export async function providerReady(model: string): Promise<{ ok: boolean; reason?: string }> {
  if (providerOf(model) === 'claude') {
    return process.env.ANTHROPIC_API_KEY
      ? { ok: true }
      : { ok: false, reason: 'ANTHROPIC_API_KEY is not set.' };
  }

  if (!process.env.OLLAMA_API_KEY) {
    return { ok: false, reason: 'OLLAMA_API_KEY is not set — get one at ollama.com/settings/keys.' };
  }
  try {
    const res = await fetch('https://ollama.com/api/tags', {
      headers: { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'ollama.com rejected OLLAMA_API_KEY.' };
    }
    if (!res.ok) return { ok: false, reason: `ollama.com answered ${res.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Could not reach ollama.com.' };
  }
}
