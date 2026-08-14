import { vaultStatus } from '@/lib/environment';
import { browseByNote } from '@/lib/queries';
import { CardsClient } from './cards-client';

export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  const [notes, vault] = await Promise.all([browseByNote(), vaultStatus()]);
  return <CardsClient notes={notes} vaultAvailable={vault.available} />;
}
