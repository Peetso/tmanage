import { redirect } from 'next/navigation';

/**
 * UX-1 (live UX test 69836a13, bug 1): `/app` — the address people type or bookmark for "the app"
 * — fell into `/:orgSlug` with the reserved slug `app` and ended on "We couldn't find that page".
 * It, and anything under it, now goes to the workspace chooser, which opens the person's own home
 * (or asks them to sign in).
 */
export default function AppEntryPage(): never {
  redirect('/organizations');
}
