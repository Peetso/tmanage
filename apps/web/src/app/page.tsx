import { redirect } from 'next/navigation';

/**
 * The root.
 *
 * There is no home screen yet — `WEB-002` and the internal work surfaces are later tickets —
 * so `/` sends a person to the one screen that is built and is the entry point for every
 * other: sign-in. A landing page that said "coming soon" would be a screen nobody specified.
 */
export default function RootPage(): never {
  redirect('/sign-in');
}
