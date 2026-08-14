import 'server-only';
import { access, constants } from 'node:fs/promises';

/**
 * Can this instance reach the Obsidian vault?
 *
 * Two of the features here — syncing and drafting from a note — read markdown off the local
 * filesystem, and one of them shells out to `npm run scan`. Neither is possible on a hosted
 * deployment: there is no vault there, and nothing to spawn it with. Rather than let those paths
 * fail with a stack trace about a missing directory, everything that depends on the vault asks
 * this first and says so plainly.
 *
 * The check is the real thing — the directory has to exist and be readable — not an inference
 * from `process.env.VERCEL`. A laptop with the env var pointing at an evicted iCloud folder is
 * just as unable to sync as a serverless function is, and should say the same thing.
 */
export async function vaultAvailable(): Promise<boolean> {
  const root = process.env.VAULT_PATH;
  if (!root) return false;
  try {
    await access(root, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why the vault is out of reach, for the one place that shows a reason. */
export async function vaultStatus(): Promise<{ available: boolean; reason: string | null }> {
  if (!process.env.VAULT_PATH) {
    return {
      available: false,
      reason: 'This copy is running without a vault — syncing and drafting need the markdown files on the same machine. Run it locally with `npm run dev` to generate cards.',
    };
  }
  if (!(await vaultAvailable())) {
    return {
      available: false,
      reason: `VAULT_PATH is set to ${process.env.VAULT_PATH}, but that folder can't be read. If it's in iCloud it may have been evicted — open it in Finder to pull it back down.`,
    };
  }
  return { available: true, reason: null };
}
