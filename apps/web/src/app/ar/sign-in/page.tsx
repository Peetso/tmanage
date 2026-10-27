import type { Metadata } from 'next';
import SignInPage from '../../sign-in/page';
import { PublicLocaleAlternates } from '../../../components/website/PublicLocaleAlternates';
import { arabicRouteMetadata } from '../../../lib/i18n/public-locale-routes';

/**
 * **ID-01 Sign in, in Arabic** — `/ar/sign-in` (Figma `428:10174`).
 *
 * The English page itself — the same screen, the same `POST /v1/auth/password`, the same `?next=`
 * rule — under the Arabic route locale, so it is prerendered right to left with Arabic labels and
 * shows its refusals in Arabic.
 */
export const metadata: Metadata = arabicRouteMetadata('/sign-in');

export default function ArabicSignInPage() {
  return (
    <>
      <PublicLocaleAlternates />
      <SignInPage />
    </>
  );
}
