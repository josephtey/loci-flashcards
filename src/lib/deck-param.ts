/**
 * The `?deck=` query on a session page, reduced to one string or nothing.
 *
 * Next hands a repeated key back as an array and a missing one as undefined; a session is drawn
 * from one deck or from all of them, so anything other than a single non-empty value means
 * "all". The value is never validated against the decks that exist — a deck with no cards
 * waiting simply yields an empty session, which the page already handles.
 */
export function deckParam(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The shape Next hands a page's `searchParams` as: a promise, resolved by the page itself. */
export type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;
