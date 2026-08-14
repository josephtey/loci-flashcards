#!/usr/bin/env tsx
import 'dotenv/config';
import { config } from 'dotenv';
import { supabase } from '../lib/supabase';

config({ path: '.env.local', override: true });

/**
 * Wipe every row so the next scan starts from a clean vault read.
 *
 * Deliberately destructive and deliberately not wired to a button. Clearing `notes` is the part
 * that matters: the note snapshot is what the diff engine compares against, so leaving it behind
 * means the next scan sees nothing changed and does nothing.
 *
 * Pass --force to skip the confirmation.
 */

// Child-before-parent, though the foreign keys would cascade anyway. The key column is named
// because PostgREST needs a filter on delete and `card_states` is keyed by `card_id`, not `id`.
const TABLES: [table: string, key: string][] = [
  ['extraction_feedback', 'id'],
  ['reviews', 'id'],
  ['card_states', 'card_id'],
  ['cards', 'id'],
  ['targets', 'id'],
  ['note_blocks', 'id'],
  ['notes', 'id'],
  ['scan_runs', 'id'],
];

async function main() {
  const db = supabase();

  if (!process.argv.includes('--force')) {
    const counts: string[] = [];
    for (const table of ['notes', 'targets', 'cards', 'reviews']) {
      const { count } = await db.from(table).select('id', { count: 'exact', head: true });
      counts.push(`${count ?? 0} ${table}`);
    }
    console.log(`\nThis deletes: ${counts.join(', ')}.`);
    console.log('Re-run with --force to confirm.\n');
    return;
  }

  for (const [table, key] of TABLES) {
    // PostgREST requires a filter on delete; this one matches every row.
    const { error } = await db.from(table).delete().not(key, 'is', null);
    if (error) throw new Error(`${table}: ${error.message}`);
    process.stdout.write(`  cleared ${table}\n`);
  }

  console.log('\nReset. Next scan will treat the whole vault as new.\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
