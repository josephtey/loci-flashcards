import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated, mustRefuse } from '@/lib/auth';

/**
 * The front door. Every page and API route passes through here; only the login page, the login
 * endpoint, and the static bits a home-screen install needs (manifest, icons) are exempt.
 *
 * Pages redirect to /login; API routes get a 401 — a fetch from the review screen should fail
 * loudly rather than receive an HTML login form as its JSON.
 */
export async function proxy(req: NextRequest) {
  if (mustRefuse()) {
    return new NextResponse('LOCI_PASSWORD is not set on this deployment.', { status: 500 });
  }
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
