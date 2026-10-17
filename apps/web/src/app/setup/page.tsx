import type { Metadata } from 'next';
import { FirstOwnerSetupScreen } from '../../components/screens/FirstOwnerSetupScreen';

/**
 * **First-owner setup.**
 *
 * A fresh production install has no organizations and no public sign-up. When the API has
 * `SETUP_TOKEN` set and no organization / owner exists yet, this page lets the operator create the
 * first organization and its owner; otherwise the screen shows "not available".
 *
 * The static `/setup` segment takes precedence over `[orgSlug]`, and the API reserves the slug
 * `setup` (`organization-input.ts`), so no organization can be shadowed by this route. It takes no
 * query parameters: the setup token is typed into the form and never put in a URL.
 */
export const metadata: Metadata = {
  title: 'Set up TManage',
  robots: { index: false, follow: false },
};

export default function SetupPage() {
  return <FirstOwnerSetupScreen />;
}
