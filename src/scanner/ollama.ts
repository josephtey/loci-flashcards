import type Anthropic from '@anthropic-ai/sdk';

/**
 * Local models via Ollama's native /api/chat. The stage's JSON schema goes in as `format` so the
 * structured output survives; the Anthropic-compatible endpoint ignores output_config.format.
 * Any model that isn't `claude-*` is routed here.
 */

const OLLAMA_URL = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');

// Ollama's 4k default would truncate the stage-1 prompt.
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

  // One retry on a schema mismatch.
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
