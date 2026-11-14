import type { Metadata } from 'next';
import { SignUpScreen } from '../../components/screens/SignUpScreen';
import { PublicLocaleAlternates } from '../../components/website/PublicLocaleAlternates';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

/**
 * **Sign up** — public self-service account creation (`PUBLIC_SIGNUP`, default on). The screen
 * asks the API whether sign-up is open and shows "not open" when the switch is off. The API
 * reserves the slug `sign-up`, so this static segment shadows no organization.
 */
export const metadata: Metadata = {
  title: 'Create your TManage account',
};

export default function SignUpPage() {
  return (
    <>
      <PublicLocaleAlternates />
      <SignUpScreen />
    </>
  );
}
