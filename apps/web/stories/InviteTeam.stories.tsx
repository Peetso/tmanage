import type { Meta, StoryObj } from '@storybook/react-vite';
import { InviteTeamScreen } from '../src/components/screens/InviteTeamScreen';
import {
  FIXTURE_EXISTING_MEMBERS,
  FIXTURE_ORGANIZATION_DOMAIN,
  FIXTURE_SIGNED_IN_AS,
} from '../src/lib/fixtures';
import { refusingClient } from './support/stub-client';

/**
 * **ON-04 Invite team** — the last step of the onboarding sequence.
 *
 * The screen needs three facts it cannot fetch: who is signed in, the organization's own mail
 * domain, and which addresses already hold a membership. All three come from
 * `src/lib/fixtures.ts`, the same source `tests/screens.test.tsx` uses, so the domain rule
 * (an address outside the organization's domain is a client, not a colleague) and the
 * duplicate rule are both live in this story rather than being a paragraph about them.
 */
const meta = {
  title: 'Onboarding/ON-04 Invite team',
  component: InviteTeamScreen,
  args: {
    signedInAs: FIXTURE_SIGNED_IN_AS,
    organizationSlug: 'northstar',
    organizationDomain: FIXTURE_ORGANIZATION_DOMAIN,
    existingMembers: FIXTURE_EXISTING_MEMBERS,
    client: refusingClient(),
  },
} satisfies Meta<typeof InviteTeamScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
