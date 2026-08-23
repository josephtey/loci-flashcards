import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_MAX_AGE, passwordMatches, sessionToken } from '@/lib/auth';

/** Plain form POST from /login. Sets the session cookie and sends you where you were going. */
export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get('password') ?? '');
  const next = sanitiseNext(String(form.get('next') ?? '/'));

  if (!(await passwordMatches(password))) {
    const url = new URL('/login', req.url);
    url.searchParams.set('error', '1');
    if (next !== '/') url.searchParams.set('next', next);
    return NextResponse.redirect(url, { status: 303 });
  }

  const res = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, (await sessionToken())!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}

/** Only ever redirect within the app — never to a URL the form was handed. */
function sanitiseNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
