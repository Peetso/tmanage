import type { Meta, StoryObj } from '@storybook/react-vite';
import { InvitationScreen } from '../src/components/screens/InvitationScreen';
import { STORY_INVITATION_TOKEN, invitationPreviewClient } from './support/stub-client';

/**
 * **ID-03 Invitation.**
 *
 * The screen resolves its own invitation as of TEN-003, so it needs a client that answers. The
 * body the stub returns is the one `tests/screens.test.tsx` uses — a deliberate reuse, because
 * that test learned the hard way that a 200 of the wrong shape hands `Avatar` an `undefined`
 * and throws *after* the assertions pass.
 *
 * The token is sent in a body and never rendered into the document. It is a fixed 43-character
 * string here for the same reason it is in the test: the shape matters, the value does not.
 */
const meta = {
  title: 'Identity/ID-03 Invitation',
  component: InvitationScreen,
  args: { token: STORY_INVITATION_TOKEN, client: invitationPreviewClient() },
} satisfies Meta<typeof InvitationScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An internal invitation, resolved. */
export const Resolved: Story = {};
