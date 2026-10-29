import type { Meta, StoryObj } from '@storybook/react-vite';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { refusingClient } from './support/stub-client';

/**
 * **ID-01 Sign in.**
 *
 * The email-and-password form is real; passkeys and company SSO are not built, so they are not
 * rendered (57-05) until 56-22 and 54-14 ship them. The two stories below are the two shapes this screen actually ships in,
 * and the difference is not cosmetic: the development panel is rendered only where the API
 * registered `/v1/dev/sessions`, which production does not do at all.
 *
 * A refusing client is injected so that pressing "Sign in" in a story cannot send a password to
 * whatever origin `public-config.ts` resolved at build time.
 */
const meta = {
  title: 'Identity/ID-01 Sign in',
  component: SignInScreen,
  args: { client: refusingClient() },
} satisfies Meta<typeof SignInScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Production: the real form, the two unbuilt methods disabled, no development panel. */
export const Production: Story = { args: { developmentSignInEnabled: false } };

/**
 * Development: the extra panel that issues a session for a user id on trust. It is still the
 * only way to reach a session for a seeded user who has never had a password set.
 */
export const WithDevelopmentPanel: Story = { args: { developmentSignInEnabled: true } };
