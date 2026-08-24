import { readFile } from 'node:fs/promises';

/**
 * Does the rubric still grade the way you think it does?
 *
 * `npm run bench:grade [model...]` — replays a fixed set of real cards from the deck against
 * typed answers spanning all four grades, and reports how often the model agrees with the grade
 * a human would give.
 *
 * This exists because the rubric in `prompts/grade-answer.md` is prose, and prose has no tests.
 * Every wording change to it is a silent change to how the deck gets scheduled — the first
 * version of the rubric scored 15/17 and gave *every* correct answer an Easy, which would have
 * quietly stretched every interval in the deck. Nothing surfaced that except measuring it.
 *
 * The `want` arrays are deliberately a human's judgement, written down. When you disagree with
 * one, change it — an argument about what a case *should* score is the useful part.
 */

const HOST = 'https://ollama.com';
const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  authorization: `Bearer ${process.env.OLLAMA_API_KEY ?? ''}`,
};

const FORMAT = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    missing: { type: 'string' },
    rating: { type: 'integer', enum: [1, 2, 3, 4] },
  },
  required: ['verdict', 'missing', 'rating'],
};

interface Case {
  q: string;
  expected: string;
  angle: string;
  angleDesc: string;
  context?: string;
  typed: string;
  want: number[]; // acceptable grades
}

const CASES: Case[] = [
  // ── Cell Painting ────────────────────────────────────────────────────────
  {
    q: 'What is Cell Painting?',
    expected: "A method Recursion pioneered for universally profiling a cell's state via imaging.",
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    context: 'Used as the imaging readout step after dosing wells with an intervention.',
    typed: "Recursion's imaging assay for universally profiling a cell's state — stain it, image it, get a high-dimensional phenotypic fingerprint",
    want: [3, 4],  // conspicuously more precise than required — Easy is defensible here
  },
  {
    q: 'What is Cell Painting?',
    expected: "A method Recursion pioneered for universally profiling a cell's state via imaging.",
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    typed: 'imaging method recursion made to profile what state a cell is in',
    want: [3],  // exactly the reference, nothing more: the definition of a Good
  },
  {
    q: 'What is Cell Painting?',
    expected: "A method Recursion pioneered for universally profiling a cell's state via imaging.",
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    typed: 'a way of taking pictures of cells',
    want: [1, 2],
  },
  {
    q: 'What is Cell Painting?',
    expected: "A method Recursion pioneered for universally profiling a cell's state via imaging.",
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    typed: 'a sequencing technique for measuring gene expression across a population',
    want: [1],
  },

  // ── destructive imaging ──────────────────────────────────────────────────
  {
    q: "Why does Recursion need a separate 'healthy cell' baseline image rather than re-imaging the same well before and after intervention?",
    expected:
      "Because Cell Painting is destructive — it kills the cells while imaging them, so the same well can't be imaged twice.",
    angle: 'causes-effects',
    angleDesc: 'what it does, what makes it do that, when it is used',
    typed: "cell painting kills the cells, so you can't image the same well twice",
    want: [3],
  },
  {
    q: "Why does Recursion need a separate 'healthy cell' baseline image rather than re-imaging the same well before and after intervention?",
    expected:
      "Because Cell Painting is destructive — it kills the cells while imaging them, so the same well can't be imaged twice.",
    angle: 'causes-effects',
    angleDesc: 'what it does, what makes it do that, when it is used',
    typed: 'because the imaging destroys them',
    want: [2, 3],
  },
  {
    q: "Why does Recursion need a separate 'healthy cell' baseline image rather than re-imaging the same well before and after intervention?",
    expected:
      "Because Cell Painting is destructive — it kills the cells while imaging them, so the same well can't be imaged twice.",
    angle: 'causes-effects',
    angleDesc: 'what it does, what makes it do that, when it is used',
    typed: 'because the cells drift around between the two images so you cannot line them up',
    want: [1],
  },

  // ── transform / transfect (one word answer) ──────────────────────────────
  {
    q: 'Which term — transform or transfect — is used for introducing DNA into bacteria?',
    expected: 'Transform.',
    angle: 'contrast',
    angleDesc: 'what relates it to and distinguishes it from an adjacent concept',
    typed: 'transform',
    want: [3, 4],  // a one-word card: complete is all it can be
  },
  {
    q: 'Which term — transform or transfect — is used for introducing DNA into bacteria?',
    expected: 'Transform.',
    angle: 'contrast',
    angleDesc: 'what relates it to and distinguishes it from an adjacent concept',
    typed: 'transfect',
    want: [1],
  },

  // ── RBM39 / CDK12 ────────────────────────────────────────────────────────
  {
    q: 'Why did researchers target RBM39 instead of CDK12 directly when developing REC-1245?',
    expected: 'Because CDK12, though a well-validated cancer target, is very hard to drug selectively.',
    angle: 'significance',
    angleDesc: 'why it matters, what it implies, the "so what?"',
    typed: 'cdk12 is really hard to drug selectively',
    want: [3],
  },
  {
    q: 'Why did researchers target RBM39 instead of CDK12 directly when developing REC-1245?',
    expected: 'Because CDK12, though a well-validated cancer target, is very hard to drug selectively.',
    angle: 'significance',
    angleDesc: 'why it matters, what it implies, the "so what?"',
    typed: 'because rbm39 was cheaper to synthesise',
    want: [1],
  },

  // ── hydrophobic effect ───────────────────────────────────────────────────
  {
    q: 'What actually drives the hydrophobic effect — attraction between non-polar groups, or something else?',
    expected:
      'The entropy cost water pays to order itself around each exposed non-polar group — not attraction between the groups themselves.',
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    context: "Common misconception: it's not that hydrophobic groups attract each other.",
    typed:
      'entropy — water has to order itself into a cage around each nonpolar group and that costs entropy. not actual attraction between the groups',
    want: [3, 4],  // names the mechanism and the contrast
  },
  {
    q: 'What actually drives the hydrophobic effect — attraction between non-polar groups, or something else?',
    expected:
      'The entropy cost water pays to order itself around each exposed non-polar group — not attraction between the groups themselves.',
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    typed: 'something to do with water and entropy i think',
    want: [1, 2],
  },
  {
    q: 'What actually drives the hydrophobic effect — attraction between non-polar groups, or something else?',
    expected:
      'The entropy cost water pays to order itself around each exposed non-polar group — not attraction between the groups themselves.',
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    typed: 'the nonpolar groups attract each other via van der waals',
    want: [1],
  },

  {
    q: 'What actually drives the hydrophobic effect — attraction between non-polar groups, or something else?',
    expected:
      'The entropy cost water pays to order itself around each exposed non-polar group — not attraction between the groups themselves.',
    angle: 'definition',
    angleDesc: 'what this term or entity is — the plain, retrievable meaning',
    // The expected answer explicitly denies this. Landing on the misconception the card exists
    // to correct is the most expensive thing to score as partial credit.
    typed: 'the nonpolar groups pull on each other',
    want: [1],
  },

  // ── cloze: only the deletion is the answer ───────────────────────────────
  {
    q: 'Drugs can fail for one of 4 reasons: 1. Drug doesn\'t work 2. Toxicity 3. [⋯] 4. Non-scientific',
    expected: 'Population dilution',
    angle: 'parts-wholes',
    angleDesc: 'sub-types, super-categories, what it is a part of',
    context:
      "Population dilution: heterogeneous trial populations dilute a drug's true effect on the subgroup it actually helps.",
    typed: 'population dilution',
    want: [3, 4],  // a cloze deletion: exact match is all there is
  },
  {
    q: 'Drugs can fail for one of 4 reasons: 1. Drug doesn\'t work 2. Toxicity 3. [⋯] 4. Non-scientific',
    expected: 'Population dilution',
    angle: 'parts-wholes',
    angleDesc: 'sub-types, super-categories, what it is a part of',
    typed: 'bad trial design',
    want: [1, 2],
  },

  // ── partial: two components asked, one given ─────────────────────────────
  {
    q: 'How does the goal of the generic healthy-cell map differ from that of the disease-reversal screen?',
    expected:
      'The disease-reversal screen aims to find a new drug intervention; the generic map aims to understand what interventions do mechanistically.',
    angle: 'contrast',
    angleDesc: 'what relates it to and distinguishes it from an adjacent concept',
    typed: 'the reversal screen is looking for a drug',
    want: [2],
  },
];

function brief(c: Case): string {
  const parts = [
    `The card asks:\n${c.q}`,
    `\nThe answer it was written to elicit:\n${c.expected}`,
    `\nThis card reinforces "${c.angle}" — ${c.angleDesc}. That is what has to come back; nothing else about the topic is being tested.`,
  ];
  if (c.context) {
    parts.push(
      `\nBackground, shown only after the reveal (the answer does not need to contain any of it):\n${c.context}`,
    );
  }
  parts.push(`\nWhat was typed:\n${c.typed}`);
  return parts.join('\n');
}

async function grade(model: string, system: string, c: Case) {
  const t = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model,
      stream: false,
      // gpt-oss ignores `think: false` and spends the whole budget reasoning, returning empty
      // content; it wants a level. Everything else takes the boolean.
      think: 'low',
      format: FORMAT,
      options: { temperature: 0, num_predict: 1200 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: brief(c) },
      ],
    }),
  });
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  if (!body.message?.content) throw new Error('empty response (model returned no content)');
  return { ...extractJson(body.message?.content ?? ''), ms: Date.now() - t };
}

// Mirrors src/lib/grader.ts — ollama.com does not compile the `format` grammar, so the contract
// has to be stated in words too or a cloud model answers with prose.
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

function extractJson(raw: string): { rating: number; verdict: string; missing: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* scan below */
  }
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in reply: ${text.slice(0, 90)}`);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') inString = !inString;
    else if (!inString && c === '{') depth++;
    else if (!inString && c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error(`unterminated JSON: ${text.slice(0, 90)}`);
}

const system = (await readFile('prompts/grade-answer.md', 'utf8')) + CONTRACT;
const models = process.argv.slice(2);
if (!models.length) models.push('gpt-oss:120b');

for (const model of models) {
  console.log(`\n${'='.repeat(78)}\n  ${model}\n${'='.repeat(78)}`);
  let hits = 0;
  const times: number[] = [];

  // Warm, so the first case doesn't carry the load time into the average.
  await grade(model, system, CASES[0]).catch(() => {});

  for (const c of CASES) {
    const r = await grade(model, system, c);
    times.push(r.ms);
    const ok = c.want.includes(r.rating);
    if (ok) hits++;
    const NAMES = ['', 'Again', 'Hard', 'Good', 'Easy'];
    console.log(
      `\n${ok ? '  ✓' : '  ✗'} ${NAMES[r.rating]}  (wanted ${c.want.map((w) => NAMES[w]).join('/')})  ${r.ms}ms`,
    );
    console.log(`     typed:   "${c.typed.slice(0, 78)}"`);
    console.log(`     verdict: ${r.verdict}`);
    if (r.missing) console.log(`     missing: ${r.missing}`);
  }

  times.sort((a, b) => a - b);
  console.log(
    `\n  ── ${model}: ${hits}/${CASES.length} agreed · median ${times[Math.floor(times.length / 2)]}ms · max ${times[times.length - 1]}ms`,
  );
}
