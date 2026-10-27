import type { Metadata } from 'next';
import { SignUpScreen } from '../../../components/screens/SignUpScreen';
import { PublicLocaleAlternates } from '../../../components/website/PublicLocaleAlternates';
import { arabicRouteMetadata } from '../../../lib/i18n/public-locale-routes';

/**
 * **Sign up, in Arabic** — `/ar/sign-up` (Figma `428:10214`). The same screen and sign-up call
 * as `/sign-up`, under the Arabic route locale.
 */
export const metadata: Metadata = arabicRouteMetadata('/sign-up');

export default function ArabicSignUpPage() {
  return (
    <>
      <PublicLocaleAlternates />
      <SignUpScreen />
    </>
  );
}
