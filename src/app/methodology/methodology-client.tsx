'use client';

import Link from 'next/link';
import { HomeButton } from '@/components/home-button';
import { useCallback, useEffect, useState } from 'react';
import type { Config } from '@/lib/prompt-store';

// Declared here rather than imported: `prompt-store` reads the filesystem, and importing a
// *value* from it would pull `node:fs` into the client bundle. The type import above is erased
// at compile time, so it costs nothing.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface Prompt {
  key: string;
  title: string;
  file: string;
  role: string;
  /** null when the file could not be read — an empty editor here would invite saving over it. */
  body: string | null;
}

const STAGES = [
  {
    n: '1',
    title: 'Find what is worth remembering',
    body: 'Reads a note and proposes reinforcement targets — a span plus which of 16 angles to reinforce on it. This is the hardest judgement in the pipeline and the one the model is worst at, because it cannot see what you already know. A sweep covers proportionally; a targeted request finds only what you asked for.',
    prompts: ['stage1-sweep', 'stage1-targeted'],
  },
  {
    n: '2',
    title: 'Write the cards',
    body: 'Turns each target into several candidate cards, on that target’s angle. Every candidate has to argue itself against the five properties — focused, precise, consistent, tractable, effortful — and that argument is passed to the judge.',
    prompts: ['stage2-write'],
  },
  {
    n: '3',
    title: 'Filter',
    body: 'Scores every candidate 0–10 cold, without having written it, and keeps the best. Rejected candidates are almost never malformed — they are well-formed questions that miss what was interesting, or that can be answered by rearranging the question.',
    prompts: ['stage3-judge'],
  },
  {
    n: '4',
    title: 'Drop duplicates',
    body: 'Compares each survivor against the deck by character trigram. Above a threshold it is dropped outright; in a grey band the model is asked whether the two are functionally the same question, since paraphrases share no trigrams.',
    prompts: ['dedup'],
  },
] as const;

const NUMERIC: (keyof Config)[] = [
  'wordsPerTarget',
  'targetsPerNoteMax',
  'candidatesPerTarget',
  'cardsPerTarget',
  'keepScoreThreshold',
  'batchSize',
  'duplicateCertain',
  'duplicateGrey',
  'coverageContext',
  'emphasisWeight',
];

export function MethodologyClient() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/prompts');
    const d = (await res.json()) as {
      prompts: Prompt[];
      config: Config;
      labels: Record<string, string>;
    };
    setPrompts(d.prompts);
    setConfig(d.config);
    setLabels(d.labels);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const byKey = (k: string) => prompts.find((p) => p.key === k);

  const edit = useCallback(
    (key: string) => {
      if (open === key) {
        setOpen(null);
        return;
      }
      setOpen(key);
      setDraft(byKey(key)?.body ?? '');
      setError(null);
    },
    [open, prompts],
  );

  const savePrompt = useCallback(async () => {
    if (!open) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: open, body: draft }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      setPrompts((prev) => prev.map((p) => (p.key === open ? { ...p, body: draft } : p)));
      setSaved(open);
      setTimeout(() => setSaved(null), 2500);
      setOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [open, draft]);

  const saveConfig = useCallback(
    async (patch: Partial<Config>) => {
      setError(null);
      const optimistic = { ...(config as Config), ...patch };
      setConfig(optimistic);
      const res = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: patch }),
      });
      if (!res.ok) {
        setError(((await res.json()) as { error: string }).error);
        void load(); // put the rejected value back
      }
    },
    [config, load],
  );

  return (
    <main className="safe-b safe-t mx-auto flex min-h-dvh max-w-3xl flex-col px-5 pb-6 sm:px-8 sm:pb-10 sm:[--safe-t-base:2.5rem]">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <HomeButton />
          <h1 className="text-lg font-light">Methodology</h1>
          <p className="mt-0.5 text-xs text-ink-3">
            how cards get made — and every prompt behind it, editable
          </p>
        </div>
      </header>

      {error && (
        <p className="rise mt-8 rounded border border-ink-4 bg-surface px-4 py-3 text-sm text-ink-2">
          {error}
        </p>
      )}

      {/* The pipeline, stage by stage, each with its prompt underneath. */}
      <section className="mt-14 space-y-12">
        {STAGES.map((stage) => (
          <div key={stage.n}>
            <div className="flex items-baseline gap-4">
              <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">{stage.n}</span>
              <h2 className="text-base font-light">{stage.title}</h2>
            </div>
            <p className="mt-3 pl-8 text-sm leading-relaxed text-ink-3">{stage.body}</p>

            <div className="mt-4 space-y-2 pl-8">
              {stage.prompts.map((key) => {
                const p = byKey(key);
                if (!p) return null;
                return (
                  <div key={key}>
                    <button
                      onClick={() => edit(key)}
                      className="group flex w-full items-baseline gap-3 py-1.5 text-left"
                    >
                      <span className="font-mono text-[0.625rem] text-ink-4">
                        {open === key ? '−' : '+'}
                      </span>
                      <span className="text-sm text-ink-2 group-hover:text-ink">{p.title}</span>
                      <span className="flex-1 truncate font-mono text-[0.625rem] text-ink-4">
                        {p.file}
                      </span>
                      {saved === key && (
                        <span className="text-[0.6875rem] text-ink-3">saved</span>
                      )}
                    </button>

                    {open === key && (
                      <div className="rise mt-2">
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          spellCheck={false}
                          className="h-96 w-full resize-y rounded border border-ink-4 bg-surface p-4 font-mono text-[0.6875rem] leading-relaxed text-ink-2"
                        />
                        <div className="mt-2 flex items-center gap-4">
                          <button
                            onClick={() => void savePrompt()}
                            disabled={saving || !draft.trim()}
                            className="rounded border border-ink-4 px-3 py-1.5 text-xs text-ink-2 hover:border-ink-2 hover:text-ink disabled:opacity-30"
                          >
                            {saving ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            onClick={() => setOpen(null)}
                            className="text-xs text-ink-3 hover:text-ink"
                          >
                            Cancel
                          </button>
                          <span className="ml-auto text-[0.6875rem] text-ink-4">
                            takes effect on the next scan
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Shared principles, injected into every stage above. */}
      <section className="mt-16 border-t border-ink-4 pt-10">
        <h2 className="text-base font-light">Shared principles</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-3">
          Distilled from Andy Matuschak&apos;s work on prompt-writing, and injected verbatim into
          all four stages wherever <code>{'{{PRINCIPLES}}'}</code> appears. Handing the model the
          principles explicitly measurably improves what it writes — which is why every candidate
          also has to justify itself against them.
        </p>
        <div className="mt-4">
          {(() => {
            const p = byKey('principles');
            if (!p) return null;
            return (
              <div>
                <button
                  onClick={() => edit('principles')}
                  className="group flex w-full items-baseline gap-3 py-1.5 text-left"
                >
                  <span className="font-mono text-[0.625rem] text-ink-4">
                    {open === 'principles' ? '−' : '+'}
                  </span>
                  <span className="text-sm text-ink-2 group-hover:text-ink">{p.title}</span>
                  <span className="flex-1 truncate font-mono text-[0.625rem] text-ink-4">
                    {p.file}
                  </span>
                  {saved === 'principles' && (
                    <span className="text-[0.6875rem] text-ink-3">saved</span>
                  )}
                </button>
                {open === 'principles' && (
                  <div className="rise mt-2">
                    {byKey('principles')?.body === null && (
                      <p className="mb-2 rounded border border-mem-fresh/40 px-3 py-2 text-xs leading-relaxed text-mem-fresh">
                        This file could not be read from disk, so the box below is empty — saving
                        would overwrite it. Check the server log for the path it tried.
                      </p>
                    )}
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      className="h-96 w-full resize-y rounded border border-ink-4 bg-surface p-4 font-mono text-[0.6875rem] leading-relaxed text-ink-2"
                    />
                    <div className="mt-2 flex items-center gap-4">
                      <button
                        onClick={() => void savePrompt()}
                        disabled={saving || !draft.trim()}
                        className="rounded border border-ink-4 px-3 py-1.5 text-xs text-ink-2 hover:border-ink-2 hover:text-ink disabled:opacity-30"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setOpen(null)}
                        className="text-xs text-ink-3 hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </section>

      {/* Tuning. */}
      {config && (
        <section className="mt-16 border-t border-ink-4 pt-10 pb-16">
          <h2 className="text-base font-light">Tuning</h2>
          <p className="mt-3 text-sm text-ink-3">
            Saved on change. Applies to the next scan.
          </p>

          <div className="mt-8 space-y-5">
            {NUMERIC.map((k) => (
              <label key={k} className="flex items-baseline gap-4">
                <input
                  type="number"
                  step={k.startsWith('duplicate') ? 0.01 : 1}
                  value={config[k] as number}
                  onChange={(e) => void saveConfig({ [k]: Number(e.target.value) } as Partial<Config>)}
                  className="w-20 shrink-0 rounded border border-ink-4 bg-surface px-2 py-1 text-right font-mono text-xs tabular-nums text-ink"
                />
                <span className="w-44 shrink-0 font-mono text-[0.6875rem] text-ink-2">{k}</span>
                <span className="text-xs leading-relaxed text-ink-3">{labels[k]}</span>
              </label>
            ))}

            {(['effortStage1', 'effortStage2', 'effortStage3'] as const).map((k) => (
              <label key={k} className="flex items-baseline gap-4">
                <select
                  value={config[k]}
                  onChange={(e) => void saveConfig({ [k]: e.target.value } as Partial<Config>)}
                  className="w-20 shrink-0 rounded border border-ink-4 bg-surface px-2 py-1 font-mono text-xs text-ink"
                >
                  {EFFORTS.map((v) => (
                    <option key={v} value={v} className="bg-surface">
                      {v}
                    </option>
                  ))}
                </select>
                <span className="w-44 shrink-0 font-mono text-[0.6875rem] text-ink-2">{k}</span>
                <span className="text-xs leading-relaxed text-ink-3">{labels[k]}</span>
              </label>
            ))}

            {(['emphasisMarker', 'model', 'modelDedup'] as const).map((k) => (
              <label key={k} className="flex items-baseline gap-4">
                <input
                  value={config[k]}
                  onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
                  onBlur={(e) => void saveConfig({ [k]: e.target.value } as Partial<Config>)}
                  className="w-44 shrink-0 rounded border border-ink-4 bg-surface px-2 py-1 font-mono text-xs text-ink"
                />
                <span className="w-20 shrink-0 font-mono text-[0.6875rem] text-ink-2">{k}</span>
                <span className="text-xs leading-relaxed text-ink-3">{labels[k]}</span>
              </label>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
