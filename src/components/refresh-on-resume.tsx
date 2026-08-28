'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-fetch this page's numbers when you come back to it.
 *
 * Every page here is `force-dynamic` and the server sends `no-cache, must-revalidate`, so a
 * request always gets fresh numbers. The problem is the times there is no request. Two of them:
 *
 *  - Launching the installed app. `display: standalone` means the phone resumes the page it had
 *    rather than loading one, so the counts you see are from whenever you last opened it — which
 *    can be yesterday. Pulling to refresh fixed it, which is exactly the tell.
 *  - Browser back and forward. Next's client router cache does not cache pages by default any
 *    more, but it does still reuse them for back/forward, which is how you get last hour's deck
 *    after backing out of a review.
 *
 * `router.refresh()` re-renders the server component and invalidates that cache without touching
 * client state or scroll position, so this is invisible apart from the numbers being right.
 */

/**
 * How long the page has to have been away before coming back is worth a re-fetch.
 *
 * Glancing at another app for two seconds and coming straight back should not cost a round trip;
 * the numbers cannot have moved. Anything longer might have been a review session on another
 * device, or a night.
 */
const STALE_AFTER_MS = 20_000;

export function RefreshOnResume() {
  const router = useRouter();

  useEffect(() => {
    let hiddenAt: number | null = null;

    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS) router.refresh();
      hiddenAt = null;
    }

    // Restored from the back/forward cache, which means the DOM is whatever it was when you left
    // and no amount of time has passed as far as the page is concerned.
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) router.refresh();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [router]);

  return null;
}
