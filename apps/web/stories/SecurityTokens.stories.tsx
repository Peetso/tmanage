import type { Meta, StoryObj } from '@storybook/react-vite';
import { SecurityScreen } from '../src/components/screens/SecurityScreen';
import {
  markVrReady,
  SECURITY_TOKENS,
  setReactInputValue,
  tokensClient,
  waitForElement,
  withStubbedNetwork,
} from './support/vr-fixtures';

/**
 * **Preferences → Security — personal access tokens (module 20).** The two states a visual
 * baseline has to pin: the list a member returns to (an active token and a revoked one, so both
 * row shapes are on screen), and the see-once dialog that appears exactly once after a token is
 * created. The second is reached by actually creating a token — the `play` fills the form and
 * presses *Create token* — because that plaintext-shown-once panel has no other way in, and a
 * baseline of a faked panel would certify markup the screen never renders.
 */
const meta = {
  title: 'VR/Security tokens',
  component: SecurityScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: { organizationSlug: 'northstar', organizationName: 'Northstar Studio' },
} satisfies Meta<typeof SecurityScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The token list: one live token with an expiry and last-used time, one revoked. */
export const Tokens: Story = {
  args: { client: tokensClient(SECURITY_TOKENS) },
};

/**
 * The see-once dialog: the plaintext token the screen shows once, right after creation. The play
 * types a name, submits, and waits for the secret to paint before letting the shot be taken.
 */
export const SeeOnce: Story = {
  tags: ['vr', 'vr-play'],
  args: { client: tokensClient([SECURITY_TOKENS[0]!]) },
  play: async ({ canvasElement }) => {
    const name = await waitForElement<HTMLInputElement>(canvasElement, '#tm-pat-name');
    setReactInputValue(name, 'MCP server — reporting');
    const submit = await waitForElement<HTMLButtonElement>(
      canvasElement,
      'form button[type="submit"]',
    );
    // React re-enables the button a tick after the controlled value lands.
    await waitForElement(canvasElement, 'form button[type="submit"]:not([disabled])');
    submit.click();
    await waitForElement(canvasElement, '[data-testid="tm-pat-secret"]');
    markVrReady();
  },
};
