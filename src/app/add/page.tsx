import { AddClient } from './add-client';

export const dynamic = 'force-dynamic';

export default function AddPage() {
  // The note list is fetched client-side: it reads the filesystem, so it's slow enough to want a
  // loading state, and the picker needs to re-fetch after a run to show updated card counts.
  return <AddClient />;
}
