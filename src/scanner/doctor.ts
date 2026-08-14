#!/usr/bin/env tsx
import 'dotenv/config';
import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { scanVault, vaultFolders, vaultRoot } from './vault';

config({ path: '.env.local', override: true });

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const TABLES = [
  'notes',
  'note_blocks',
  'scan_runs',
  'targets',
  'cards',
  'card_states',
  'reviews',
  'extraction_feedback',
  'due_cards',
];

let failed = 0;

function ok(label: string, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function bad(label: string, detail = '') {
  failed++;
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function warn(label: string, detail = '') {
  console.log(`  ${YELLOW}!${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

async function checkEnv() {
  console.log(`\n${BOLD}environment${RESET}`);
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  url ? ok('SUPABASE_URL', url) : bad('SUPABASE_URL', 'missing');
  key ? ok('SUPABASE_SECRET_KEY', `${key.slice(0, 12)}…`) : bad('SUPABASE_SECRET_KEY', 'missing');
  process.env.ANTHROPIC_API_KEY
    ? ok('ANTHROPIC_API_KEY', 'set')
    : bad('ANTHROPIC_API_KEY', 'missing — extraction will fail');
  process.env.VAULT_PATH ? ok('VAULT_PATH') : bad('VAULT_PATH', 'missing');

  return { url, key };
}

async function checkVault() {
  console.log(`\n${BOLD}vault${RESET}`);
  try {
    const { notes, unreadable } = await scanVault();
    ok(vaultRoot());
    ok(`${notes.length} notes`, vaultFolders().join(', '));
    const stubs = notes.filter((n) => n.isStub).length;
    const embeds = notes.filter((n) => n.embeds.length).length;
    console.log(
      `    ${DIM}${stubs} stubs (skipped) · ${embeds} with image embeds · ` +
        `${notes.reduce((s, n) => s + n.wikilinks.length, 0)} wikilinks${RESET}`,
    );
    if (unreadable.length) {
      warn(`${unreadable.length} unreadable`, 'iCloud eviction — open them in Obsidian once');
    }
  } catch (err) {
    bad('vault unreadable', err instanceof Error ? err.message : String(err));
  }
}

async function checkSchema(url?: string, key?: string) {
  console.log(`\n${BOLD}database${RESET}`);
  if (!url || !key) {
    bad('skipped', 'no credentials');
    return;
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const root = await fetch(`${url}/rest/v1/`, { headers });
    root.ok ? ok('reachable') : bad('unreachable', `HTTP ${root.status}`);
  } catch (err) {
    bad('unreachable', err instanceof Error ? err.message : String(err));
    return;
  }

  const missing: string[] = [];
  for (const table of TABLES) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, {
      headers: { ...headers, Prefer: 'count=exact' },
    });
    if (res.status === 404) missing.push(table);
    else if (!res.ok) missing.push(`${table} (HTTP ${res.status})`);
  }

  if (missing.length === TABLES.length) {
    bad('schema not applied', 'run supabase/migrations/0001_init.sql in the SQL editor');
  } else if (missing.length) {
    bad(`${missing.length} missing`, missing.join(', '));
  } else {
    ok(`all ${TABLES.length} tables present`);

    // Counts, so a scan can be sanity-checked against them afterwards.
    for (const table of ['notes', 'targets', 'cards', 'reviews']) {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, {
        headers: { ...headers, Prefer: 'count=exact' },
      });
      const range = res.headers.get('content-range');
      console.log(`    ${DIM}${table}: ${range?.split('/')[1] ?? '?'}${RESET}`);
    }
  }
}

async function checkModel() {
  console.log(`\n${BOLD}model${RESET}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    bad('skipped', 'no ANTHROPIC_API_KEY');
    return;
  }
  try {
    // Cheapest possible round trip that still proves auth and model access.
    const res = await new Anthropic().messages.create({
      model: process.env.LOCI_MODEL ?? 'claude-sonnet-5',
      max_tokens: 8,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    const text = res.content.find((b) => b.type === 'text');
    ok(`${process.env.LOCI_MODEL ?? 'claude-sonnet-5'} reachable`, text && text.type === 'text' ? text.text.trim() : '');
  } catch (err) {
    bad('model call failed', err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  console.log(`\n${BOLD}loci${RESET} ${DIM}· preflight${RESET}`);
  const { url, key } = await checkEnv();
  await checkVault();
  await checkSchema(url, key);
  await checkModel();

  console.log();
  if (failed) {
    console.log(`${RED}${failed} problem${failed === 1 ? '' : 's'}${RESET} — fix, then re-run.`);
    console.log();
    process.exit(1);
  }
  console.log(`${GREEN}Ready.${RESET} ${DIM}npm run scan${RESET}`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
