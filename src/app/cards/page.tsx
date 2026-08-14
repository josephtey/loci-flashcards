import { browseByNote } from '@/lib/queries';
import { CardsClient } from './cards-client';

export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  return <CardsClient notes={await browseByNote()} />;
}
