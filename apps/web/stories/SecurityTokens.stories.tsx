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
 * opens *New token*, types a name, submits, and waits for the secret to paint before letting the
 * shot be taken.
 */
export const SeeOnce: Story = {
  tags: ['vr', 'vr-play'],
  args: { client: tokensClient([SECURITY_TOKENS[0]!]) },
  play: async ({ canvasElement }) => {
    // The form lives in a dialog that *New token* opens; the dialog may render outside the
    // story canvas, so everything after that click is looked up on the whole document.
    const open = await waitForElement<HTMLButtonElement>(canvasElement, '.tm-sec-card button');
    open.click();
    const name = await waitForElement<HTMLInputElement>(document, 'form.tm-sec-form .tm-sec-input');
    setReactInputValue(name, 'MCP server — reporting');
    // React re-enables the button a tick after the controlled value lands.
    const submit = await waitForElement<HTMLButtonElement>(
      document,
      'form.tm-sec-form button[type="submit"]:not([disabled])',
    );
    submit.click();
    await waitForElement(document, '[data-testid="tm-token-secret"]');
    markVrReady();
  },
};
