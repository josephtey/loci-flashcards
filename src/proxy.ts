import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';

/**
 * The front door, when there is one. With `LOCI_PASSWORD` unset this passes everything through.
 * With it set, every page and API route is gated; only the login page, the login endpoint, and
 * the static bits a home-screen install needs (manifest, icons) are exempt.
 *
 * Pages redirect to /login; API routes get a 401 — a fetch from the review screen should fail
 * loudly rather than receive an HTML login form as its JSON.
 */
export async function proxy(req: NextRequest) {
  if (await isAuthenticated(req)) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const login = new URL('/login', req.url);
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except: login, Next internals, and the files a PWA install fetches unauthenticated.
    '/((?!login|api/login|_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icon-.*\\.png|apple-touch-icon\\.png).*)',
  ],
};
