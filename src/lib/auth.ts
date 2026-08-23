/**
 * One password, one cookie.
 *
 * This is a single-user app; the only thing standing between the public internet and the deck on
 * a hosted copy is this file. There is no user table and no session store: the cookie is a hash of
 * the password, so rotating `LOCI_PASSWORD` invalidates every device at once, and a stolen cookie
 * is worth exactly as much as the password it came from — no more, since it never leaves the
 * server except as an httpOnly cookie.
 *
 * Locally, with `LOCI_PASSWORD` unset, nothing is gated — `npm run dev` behaves as it always has.
 * On Vercel with it unset, everything is refused rather than silently left open.
 *
 * Web Crypto rather than `node:crypto` because this also runs in the proxy, which may be deployed
 * at the edge.
 */

export const SESSION_COOKIE = 'loci_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // a year — log in once per device

export function passwordConfigured(): boolean {
  return Boolean(process.env.LOCI_PASSWORD);
}

/** Hosted without a password is a misconfiguration, not an open door. */
export function mustRefuse(): boolean {
  return !passwordConfigured() && Boolean(process.env.VERCEL);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The value stored in the cookie. Salted with a fixed prefix so it isn't a bare hash of the password. */
export async function sessionToken(): Promise<string | null> {
  const pw = process.env.LOCI_PASSWORD;
  if (!pw) return null;
  return sha256Hex(`loci-session-v1:${pw}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  const pw = process.env.LOCI_PASSWORD;
  if (!pw) return false;
  // Compare hashes so the comparison is constant-time regardless of input length.
  return timingSafeEqual(await sha256Hex(candidate), await sha256Hex(pw));
}

/**
 * Is this request allowed in? Accepts the session cookie (browser) or a bearer token equal to the
 * password (a future native client, or curl).
 */
export async function isAuthenticated(req: { headers: Headers; cookies: { get(name: string): { value: string } | undefined } }): Promise<boolean> {
  if (!passwordConfigured()) return !mustRefuse();

  const expected = await sessionToken();
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (expected && cookie && timingSafeEqual(cookie, expected)) return true;

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return passwordMatches(auth.slice(7).trim());

  return false;
}
