import type { Metadata } from 'next';
import { SignUpWithImport } from '../../../components/screens/SignUpWithImport';
import { EntrySessionGate } from '../../../components/session/EntrySessionGate';
import { requestSessionHint } from '../../../lib/workspace-gate-request';
import { PublicLocaleAlternates } from '../../../components/website/PublicLocaleAlternates';
import { arabicRouteMetadata } from '../../../lib/i18n/public-locale-routes';

/**
 * **Sign up, in Arabic** — `/ar/sign-up` (Figma `428:10214`). The same screen and sign-up call
 * as `/sign-up`, under the Arabic route locale.
 */
export const metadata: Metadata = arabicRouteMetadata('/sign-up');

export default async function ArabicSignUpPage() {
  return (
    <>
      <PublicLocaleAlternates />
      {/* AUTHSTATE: a signed-in visitor sees "You're signed in as …", not a second sign-up. */}
      <EntrySessionGate sessionHint={await requestSessionHint()}>
        <SignUpWithImport />
      </EntrySessionGate>
    </>
  );
}
