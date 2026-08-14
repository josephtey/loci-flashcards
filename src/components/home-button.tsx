import Link from 'next/link';

/**
 * The way back, sitting above each page's title rather than floating in a corner.
 *
 * Placing it in the flow above the heading makes it read as "up one level" — the same
 * relationship a breadcrumb describes — instead of as another action competing with the page's
 * own controls on the right.
 */
export function HomeButton() {
  return (
    <Link
      href="/"
      aria-label="Home"
      className="group -ml-2 mb-2 inline-flex items-center gap-1.5 p-2 text-ink-4 transition-colors hover:text-ink-2"
    >
      <span className="text-xs">←</span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 6.8 8 2l6 4.8V14a.5.5 0 0 1-.5.5h-3.2V9.8H6.7v4.7H3.5A.5.5 0 0 1 3 14V6.8"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </Link>
  );
}
