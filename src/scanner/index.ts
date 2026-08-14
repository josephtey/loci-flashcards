#!/usr/bin/env tsx
import 'dotenv/config';
import { config } from 'dotenv';
import { supabase } from '../lib/supabase';
import { estimateCost, extract, modelsUsed } from './extract';
import { syncVault } from './sync';
import { vaultFolders, vaultRoot } from './vault';

config({ path: '.env.local', override: true });

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function log(s = '') {
  process.stdout.write(s + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const dryRun = args.has('--dry') || args.has('--sync-only');

  // --only <fragment>[,<fragment>...] restricts the run to matching paths.
  const onlyIdx = argv.indexOf('--only');
  const only =
    onlyIdx !== -1
      ? (argv[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

  // --paths <a.md,b.md>  exact vault-relative paths, from the manual picker.
  // --request <text>      a specific thing to extract. Presence of this switches the extractor
  //                       from proportional sweep to targeted mode.
  const pathsIdx = argv.indexOf('--paths');
  const paths =
    pathsIdx !== -1
      ? (argv[pathsIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
  const reqIdx = argv.indexOf('--request');
  const request = reqIdx !== -1 ? argv[reqIdx + 1] : undefined;

  log();
  log(`${BOLD}loci${RESET} ${DIM}·${RESET} scanning vault`);
  log(`${DIM}${vaultRoot()}${RESET}`);
  log(`${DIM}folders: ${vaultFolders().join(', ')}${RESET}`);
  if (only?.length) log(`${YELLOW}scoped to: ${only.join(' · ')}${RESET}`);
  if (paths?.length) log(`${YELLOW}${paths.length} note${paths.length === 1 ? '' : 's'} selected manually${RESET}`);
  if (request) log(`${YELLOW}targeted: ${request}${RESET}`);
  if (args.has('--force')) log(`${YELLOW}--force: re-extracting regardless of the snapshot${RESET}`);
  log();

  const db = supabase();
  const started = Date.now();

  const sync = await syncVault({ only, paths, force: args.has('--force') });

  log(
    `${sync.scanned} notes · ${GREEN}${sync.changes.length} changed${RESET} · ` +
      `${DIM}${sync.unchanged} unchanged${RESET}` +
      (sync.deleted.length ? ` · ${YELLOW}${sync.deleted.length} deleted${RESET}` : ''),
  );

  if (sync.unreadable.length) {
    log();
    log(`${YELLOW}${sync.unreadable.length} unreadable${RESET} ${DIM}(iCloud eviction?)${RESET}`);
    for (const u of sync.unreadable.slice(0, 5)) log(`  ${DIM}${u.path} — ${u.error}${RESET}`);
  }

  if (sync.changes.length) {
    log();
    for (const c of sync.changes) {
      const marker = c.kind === 'new' ? `${GREEN}new${RESET}` : `${YELLOW}mod${RESET}`;
      const blocks = c.diff.added.length + c.diff.changed.length;
      log(`  ${marker}  ${c.note.title} ${DIM}(${blocks} block${blocks === 1 ? '' : 's'})${RESET}`);
    }
  }

  if (dryRun) {
    log();
    log(`${DIM}--dry: stopping before extraction. No model calls made.${RESET}`);
    log();
    return;
  }

  if (!sync.changes.length) {
    log();
    log(`${DIM}Nothing changed. Nothing to extract.${RESET}`);
    log();
    return;
  }

  const { data: run, error: runError } = await db
    .from('scan_runs')
    .insert({
      trigger: args.has('--cron') ? 'cron' : 'manual',
      notes_scanned: sync.scanned,
      notes_new: sync.changes.filter((c) => c.kind === 'new').length,
      notes_changed: sync.changes.filter((c) => c.kind === 'changed').length,
      notes_deleted: sync.deleted.length,
      model: process.env.LOCI_MODEL ?? 'claude-sonnet-5',
      pid: process.pid,
      scope: only?.length ? only.join(', ') : paths?.length ? `${paths.length} notes` : null,
      request: request ?? null,
    })
    .select('id')
    .single();
  if (runError) throw new Error(`Failed to open scan run: ${runError.message}`);

  log();
  log(`${DIM}extracting…${RESET}`);

  try {
    const summary = await extract(sync, run.id as string, request);

    await db
      .from('scan_runs')
      .update({
        finished_at: new Date().toISOString(),
        status: 'completed',
        targets_proposed: summary.targetsProposed,
        cards_proposed: summary.cardsProposed,
        input_tokens: summary.usage.input + summary.usage.cacheWrite + summary.usage.cacheRead,
        output_tokens: summary.usage.output,
      })
      .eq('id', run.id as string);

    log();
    for (const n of summary.perNote) {
      if (n.skippedReason) {
        log(`  ${DIM}—  ${n.title} · ${n.skippedReason}${RESET}`);
      } else {
        log(
          `  ${GREEN}✓${RESET}  ${n.title} ${DIM}· ${n.targets} target${n.targets === 1 ? '' : 's'}, ` +
            `${n.cards} card${n.cards === 1 ? '' : 's'}${RESET}`,
        );
      }
    }

    log();
    log(
      `${BOLD}${summary.targetsProposed} targets${RESET}, ${BOLD}${summary.cardsProposed} cards${RESET} ` +
        `awaiting review` +
        (summary.duplicatesSkipped
          ? ` ${DIM}(${summary.duplicatesSkipped} near-duplicate${summary.duplicatesSkipped === 1 ? '' : 's'} dropped)${RESET}`
          : ''),
    );

    const u = summary.usage;
    const promptTokens = u.input + u.cacheWrite + u.cacheRead;
    const hitRate = promptTokens ? Math.round((u.cacheRead / promptTokens) * 100) : 0;
    log(
      `${DIM}${modelsUsed(u)} · ${u.calls} calls · ${promptTokens.toLocaleString()} in ` +
        `(${hitRate}% cached) / ${u.output.toLocaleString()} out ` +
        `· ~$${estimateCost(u).toFixed(2)} · ${((Date.now() - started) / 1000).toFixed(1)}s${RESET}`,
    );
    log();
    log(`${DIM}Review at http://localhost:3000/queue${RESET}`);
    log();
  } catch (err) {
    await db
      .from('scan_runs')
      .update({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      .eq('id', run.id as string);
    throw err;
  }
}

// Killed from the UI (or the terminal). Close the row out on the way down rather than leaving it
// claiming to be running — the app treats a live 'running' row as a job in progress.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void supabase()
      .from('scan_runs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString(), error: 'cancelled' })
      .eq('pid', process.pid)
      .eq('status', 'running')
      .then(() => process.exit(130));
    setTimeout(() => process.exit(130), 3000);
  });
}

main().catch((err) => {
  log();
  log(`${RED}scan failed${RESET}`);
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  log();
  process.exit(1);
});
