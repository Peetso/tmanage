import type { Meta, StoryObj } from '@storybook/react-vite';
import { MfaChallengeScreen } from '../src/components/screens/MfaChallengeScreen';
import { refusingClient } from './support/stub-client';

/**
 * **ID-02 Multi-factor challenge.**
 *
 * The three states here are the three a person can actually meet, and one of them exists only
 * because of a deliberate design decision: the challenge token is never put in a URL, so there
 * is no route that can produce one. Reaching `/mfa` directly therefore lands on a screen that
 * renders its layout and explains that it cannot do anything — `NoChallenge` below.
 *
 * `RateLimited` is the reason this screen is worth having a story for at all. It is otherwise
 * only reachable by failing five times, which is not a thing a designer or reviewer should have
 * to do to look at it.
 */
const meta = {
  title: 'Identity/ID-02 Multi-factor challenge',
  component: MfaChallengeScreen,
  args: { client: refusingClient() },
} satisfies Meta<typeof MfaChallengeScreen>;

export default meta;

/** An authenticator app as the default, e-mail codes as the other way (MFAOPTIONS). */
const STORY_FACTORS = [
  { kind: 'totp', label: 'Authenticator app' },
  { kind: 'email', label: 'E-mail' },
];
type Story = StoryObj<typeof meta>;

/** Reached at its own route with no challenge behind it. The honest dead end. */
export const NoChallenge: Story = {};

/** The second step of a sign-in, with the methods the challenge named (default first). */
export const WithChallenge: Story = {
  args: {
    challengeToken: 'challenge-token-for-story-only',
    factors: STORY_FACTORS,
  },
};

/** After too many attempts. Rendered here without having to produce the attempts. */
export const RateLimited: Story = {
  args: {
    challengeToken: 'challenge-token-for-story-only',
    factors: STORY_FACTORS,
    rateLimited: true,
  },
};
