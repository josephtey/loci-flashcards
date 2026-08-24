import 'server-only';
import { readConfig, readPrompt } from './prompt-store';
import { askedOf, type GraderStatus } from './grading';
import { ANGLE_DESCRIPTIONS, zRecallVerdict, type CardRow, type GradeResult } from './types';

/**
 * The auto-grader: a small Qwen model, running locally, reading a typed recall attempt.
 *
 * It is deliberately not Claude. Grading is the highest-frequency model call in the system —
 * one per card per review, forever — and it is also the easiest: compare a sentence against a
 * reference sentence. Paying frontier prices per card for that would dominate the cost of the
 * whole app while adding nothing you would notice. A 4B model on the laptop costs nothing per
 * call, runs with no network, and keeps every answer you type off anyone else's servers.
 *
 * There is no SDK here on purpose. Ollama's API is one POST with a JSON body; a dependency to
 * wrap that would be more code to keep current than the twenty lines it replaces.
 */

const LOCAL = 'http://127.0.0.1:11434';

/** Trailing slashes make `${host}/api/chat` into a 404 that reads like an outage. */
function host(): string {
  return (process.env.OLLAMA_HOST || LOCAL).replace(/\/+$/, '');
}

/**
 * Which model grades.
 *
 * `OLLAMA_MODEL` overrides the config file because `prompts/config.json` is committed and
 * read-only on a hosted deployment — a Vercel copy pointed at ollama.com would otherwise ask
 * for `qwen3.5:4b`, which only exists on the laptop, and grade nothing. Env is the only knob a
 * hosted instance actually has.
 */
async function modelName(): Promise<string> {
  return process.env.OLLAMA_MODEL?.trim() || (await readConfig()).graderModel;
}

function isLocal(): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(host());
}

function headers(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY;
  // The key is for ollama.com, so it only ever goes to ollama.com. A local Ollama would ignore
  // an Authorization header, but a credential should not be sent to a host that did not issue
  // it — and `OLLAMA_HOST` is one typo away from being some other machine on the network.
  return {
    'content-type': 'application/json',
    ...(key && !isLocal() ? { authorization: `Bearer ${key}` } : {}),
  };
}

/**
 * The shape the model must fill in.
 *
 * Hand-written rather than derived from `zVerdict` with `z.toJSONSchema`. Ollama compiles this
 * into a grammar that constrains decoding, and it wants a plain `enum` for the rating — a Zod
 * union of literals converts to `anyOf: [{const: 1}, …]`, which is the same constraint written
 * in a form the grammar builder handles far less predictably. Zod still validates what comes
 * back, so the two cannot silently disagree about anything that matters.
 */
const FORMAT = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    missing: { type: 'string' },
    rating: { type: 'integer', enum: [1, 2, 3, 4] },
  },
  required: ['verdict', 'missing', 'rating'],
} as const;

export type { GraderStatus };

/**
 * Is there a grader to talk to?
 *
 * Asked before the review screen offers the typing box, so an unreachable Ollama shows up as a
 * greyed-out toggle with a sentence explaining why, rather than as a card that sits on
 * "grading…" until it times out. Same contract as `vaultStatus()` — the check is the real
 * thing, not an inference from which host we happen to be running on.
 */
export async function graderStatus(): Promise<GraderStatus> {
  const graderModel = await modelName();
  const at = host();

  let res: Response;
  try {
    res = await fetch(`${at}/api/tags`, {
      headers: headers(),
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
  } catch {
    return {
      available: false,
      reason: isLocal()
        ? `No Ollama at ${at}. Start it with \`brew services start ollama\` — or if this copy is hosted, there is no laptop here to run it on and self-grading is the only option.`
        : `Could not reach ${at}.`,
      model: graderModel,
      host: at,
    };
  }

  if (!res.ok) {
    return {
      available: false,
      reason:
        res.status === 401 || res.status === 403
          ? `${at} rejected the API key. Check OLLAMA_API_KEY.`
          : `${at} answered ${res.status}.`,
      model: graderModel,
      host: at,
    };
  }

  const body = (await res.json()) as { models?: { name?: string }[] };
  const names = (body.models ?? []).map((m) => m.name ?? '');

  // `ollama pull qwen3.5` lands as `qwen3.5:latest`, so a config without a tag should still
  // match the thing it obviously means rather than reporting the model as missing.
  const wanted = graderModel.includes(':') ? graderModel : `${graderModel}:latest`;
  if (!names.includes(graderModel) && !names.includes(wanted)) {
    return {
      available: false,
      reason: `${graderModel} isn't pulled${isLocal() ? ` — run \`ollama pull ${graderModel}\`` : ' on this host'}.`,
      model: graderModel,
      host: at,
    };
  }

  return { available: true, reason: null, model: graderModel, host: at };
}

/** One POST to `/api/chat`, no streaming. */
async function chat(model: string, system: string, user: string, timeoutMs: number) {
  const res = await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      // Qwen3.5 is a thinking model, and thinking on this task buys nothing while costing
      // seconds per card — the reasoning we actually want is the `verdict` field, which the
      // contract already makes it write before it commits to a number.
      //
      // gpt-oss is the exception: it ignores the boolean and wants a level, and left at the
      // default it spends the entire token budget reasoning and returns empty content.
      think: model.startsWith('gpt-oss') ? 'low' : false,
      // Without this the model unloads after five idle minutes and every card that follows a
      // pause pays a cold load. Half an hour comfortably covers a review session.
      keep_alive: '30m',
      format: FORMAT,
      options: {
        // Grading has to be reproducible: the same answer to the same card must not drift
        // between a Hard and a Good depending on the sampler.
        temperature: 0,
        num_predict: model.startsWith('gpt-oss') ? 1200 : 220,
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    // Ollama puts the useful part in the body — a cloud model behind a subscription says so
    // there, and reporting "500" instead would send you looking in the wrong place.
    const detail = await res.text().catch(() => '');
    const parsed = (() => {
      try {
        return (JSON.parse(detail) as { error?: string }).error;
      } catch {
        return null;
      }
    })();
    throw new Error(parsed || `Ollama answered ${res.status}`);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? '';
}

/**
 * The output contract, appended to the rubric rather than written into it.
 *
 * `format` above constrains decoding token-by-token — but only where the server actually
 * compiles the grammar. A local Ollama does; ollama.com does not, at least for the models
 * reachable on the free tier, which answer a schema-constrained request with prose like
 * "**Score: 1** – the response does not…". Saying it in words as well costs ~60 tokens and is
 * the difference between the hosted path working and not.
 *
 * It lives here and not in `prompts/grade-answer.md` because it is a fact about the transport,
 * not about grading — and the rubric is the file Joseph edits while calibrating.
 */
const CONTRACT = [
  '',
  '---',
  '',
  'Reply with a single JSON object and nothing else. No preamble, no explanation around it, no',
  'markdown code fence. Exactly these three keys, in this order:',
  '',
  '{"verdict": "<one sentence, second person>", "missing": "<a few words, or \"\">", "rating": <1|2|3|4>}',
  '',
  '`rating` is a bare number, not a string and not a label.',
].join('\n');

/**
 * Pull the verdict object out of whatever came back.
 *
 * `JSON.parse` on the raw string is right when the grammar was enforced and wrong the moment it
 * was not — a fenced block or a sentence of preamble is enough to throw. Scanning for the first
 * balanced object handles both, and anything with no object in it at all still fails, which is
 * what we want: an unparseable answer becomes "grade this one yourself", never a guessed number.
 */
function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to a scan.
  }

  const start = text.indexOf('{');
  if (start === -1) throw new Error('The grader replied with no JSON at all.');

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
    else if (!inString && c === '}' && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('The grader replied with an unterminated JSON object.');
}

type Card = Pick<CardRow, 'type' | 'front' | 'back' | 'cloze_text' | 'context' | 'angle'>;

/** Everything the grader is allowed to know, in the order it needs it. */
function brief(card: Card, typed: string): string {
  const { question, expected } = askedOf(card);
  const parts = [
    `The card asks:\n${question}`,
    `\nThe answer it was written to elicit:\n${expected}`,
    `\nThis card reinforces "${card.angle}" — ${ANGLE_DESCRIPTIONS[card.angle]}. That is what has to come back; nothing else about the topic is being tested.`,
  ];

  // Orientation the reviewer only sees *after* answering. Marked as such, or the model will
  // start expecting the answer to contain things it was never asked for.
  if (card.context) {
    parts.push(`\nBackground, shown only after the reveal (the answer does not need to contain any of it):\n${card.context}`);
  }

  parts.push(`\nWhat was typed:\n${typed}`);
  return parts.join('\n');
}

/**
 * Grade one typed answer.
 *
 * Throws if the grader cannot be reached or will not produce a valid verdict after a retry.
 * The caller turns that into "self-grade this one" rather than a lost review — a card you have
 * already answered must never become un-gradeable because a background process died.
 */
export async function gradeAnswer(card: Card, typed: string): Promise<GradeResult> {
  const graderModel = await modelName();
  const started = Date.now();

  const answer = typed.trim();
  if (!answer) {
    // Nothing typed is a failed retrieval by definition. Spending a model call to be told so
    // would be slower and no more true.
    return {
      rating: 1,
      verdict: 'Nothing came back — you left the answer blank.',
      missing: 'the whole answer',
      model: graderModel,
      latency_ms: 0,
    };
  }

  const system = (await readPrompt('grade-answer')) + CONTRACT;
  const user = brief(card, answer);

  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // A local model is predictable — a 4B on Metal answers in about three seconds, and
      // anything past twenty means it is wedged. A cloud call is not: measured against
      // ollama.com, a typical grade takes under a second but a cold one took 42, and a timeout
      // there costs you the verdict on a card you have already answered.
      const raw = await chat(graderModel, system, user, isLocal() ? 25_000 : 75_000);
      const parsed = zRecallVerdict.parse(extractJson(raw));
      return { ...parsed, model: graderModel, latency_ms: Date.now() - started };
    } catch (err) {
      last = err;
      // A transport failure will fail again the same way; only malformed output is worth a
      // second roll of the dice, and at temperature 0 even that is a long shot.
      if (err instanceof Error && /fetch|abort|timeout|Ollama answered|subscription/i.test(err.message)) break;
    }
  }
  throw last instanceof Error ? last : new Error('The grader returned something unreadable.');
}

/**
 * Load the model into memory without grading anything.
 *
 * Fired when a typing session opens. The first call to a cold model spends several seconds
 * reading weights off disk, and paying that on the first card you answer makes the whole mode
 * feel slow for the rest of the session. Failure is silent: this is an optimisation, and the
 * real call reports its own problems.
 */
export async function warm(): Promise<void> {
  const graderModel = await modelName();
  await fetch(`${host()}/api/chat`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: graderModel,
      stream: false,
      think: false,
      keep_alive: '30m',
      messages: [{ role: 'user', content: 'hi' }],
      options: { num_predict: 1 },
    }),
  }).catch(() => {});
}
