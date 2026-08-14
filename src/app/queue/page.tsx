import { redirect } from 'next/navigation';

/**
 * Triage is gone. Vetting a card and reviewing it for the first time were the same act, and
 * splitting them meant reading every card twice. `/new` does both.
 */
export default function QueuePage() {
  redirect('/new');
}
