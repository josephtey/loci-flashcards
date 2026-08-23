import type Anthropic from '@anthropic-ai/sdk';

/**
 * Run a stage on a local model through Ollama instead of the Anthropic API.
 *
 * Everything in the pipeline is built on structured outputs — a Zod schema the model must fill
 * in — and Ollama's Anthropic-compatible endpoint ignores `output_config.format`, so pointing the
 * SDK at it produces unparseable answers. Its native `/api/chat` endpoint, on the other hand, takes
 * a JSON schema as `format` and constrains decoding to it, which is a stronger guarantee than the
 * prompt-and-hope approach. So this talks to Ollama directly and hands back the same shape `call`
 * returns: the parsed object plus token counts.
 *
 * Routing is by model name. Anything that isn't `claude-*` comes here, so
 * `LOCI_MODEL=gemma4:12b-it-qat npm run scan` is the whole switch — or `npm run scan:local`.
 *
 * Quality caveat, stated once: a 12B model writes noticeably weaker targets and prompts than
 * Sonnet, and the judge stage is only as good as the model judging. Worth it for experiments and
 * for running the nightly sweep for free; check the cards it writes before trusting it with a
 * large batch.
 */

const OLLAMA_URL = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');

/** Context window to request. Ollama's default (4k) silently truncates the stage-1 prompt. */
const NUM_CTX = () => Number(process.env.LOCI_OLLAMA_CTX ?? 32768);

export function isLocalModel(model: string): boolean {
  return !model.startsWith('claude-');
}

type StreamParams = Parameters<Anthropic['messages']['stream']>[0];

interface OllamaChunk {
  message?: { role: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const capabilityCache = new Map<string, Promise<Set<string>>>();

/** `ollama show`, once per model per process — used to decide whether to ask it to think. */
function capabilities(model: string): Promise<Set<string>> {
  let p = capabilityCache.get(model);
  if (!p) {
    p = fetch(`${OLLAMA_URL()}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Ollama has no model "${model}" (${r.status}). Pull it: ollama pull ${model}`);
        const j = (await r.json()) as { capabilities?: string[] };
        return new Set(j.capabilities ?? []);
      });
    capabilityCache.set(model, p);
  }
  return p;
}

function systemText(system: StreamParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n');
}

function userText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

export async function callOllama<T>(
  stage: string,
  params: StreamParams,
): Promise<{ parsed: T | null; usage: { input_tokens: number; output_tokens: number } }> {
  const format = (params as { output_config?: { format?: { schema?: unknown; parse?: (s: string) => T } } })
    .output_config?.format;
  const schema = format?.schema;

  const caps = await capabilities(params.model);
  const wantsThinking = Boolean((params as { thinking?: unknown }).thinking);
  const think = wantsThinking && caps.has('thinking') && process.env.LOCI_OLLAMA_THINK !== '0';

  const messages = [
    ...(params.system ? [{ role: 'system', content: systemText(params.system) }] : []),
    ...params.messages.map((m) => ({ role: m.role, content: userText(m.content) })),
  ];

  const body = {
    model: params.model,
    messages,
    stream: true,
    think,
    ...(schema ? { format: schema } : {}),
    options: { num_ctx: NUM_CTX(), num_predict: params.max_tokens, temperature: 0.3 },
  };

  // One retry: constrained decoding makes malformed JSON rare, but a model can still violate an
  // enum or leave a required field out of a nested object, and Zod will say so.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${OLLAMA_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err: Error) => {
      throw new Error(`${stage}: cannot reach Ollama at ${OLLAMA_URL()} — is it running? (${err.message})`);
    });
    if (!res.ok || !res.body) {
      throw new Error(`${stage}: Ollama ${res.status} ${await res.text().catch(() => '')}`);
    }

    let content = '';
    let final: OllamaChunk = {};
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChunk;
        if (chunk.error) throw new Error(`${stage}: Ollama: ${chunk.error}`);
        content += chunk.message?.content ?? '';
        if (chunk.done) final = chunk;
      }
    }

    if (final.done_reason === 'length') {
      throw new Error(
        `${stage}: hit num_predict (${params.max_tokens}) before finishing. Raise max_tokens or the model is rambling.`,
      );
    }

    const usage = { input_tokens: final.prompt_eval_count ?? 0, output_tokens: final.eval_count ?? 0 };
    if (!format?.parse) return { parsed: null, usage };
    try {
      return { parsed: format.parse(content), usage };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${stage}: ${params.model} returned JSON that didn't match the schema twice: ${String(lastError).slice(0, 300)}`);
}
