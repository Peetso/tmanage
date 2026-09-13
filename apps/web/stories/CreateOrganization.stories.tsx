import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreateOrganizationScreen } from '../src/components/screens/CreateOrganizationScreen';
import { FIXTURE_SIGNED_IN_AS } from '../src/lib/fixtures';
import { refusingClient } from './support/stub-client';

/**
 * **ON-01 Create organization** — the first step of the onboarding sequence.
 *
 * `signedInAs` comes from `src/lib/fixtures.ts` rather than being invented here. That file
 * exists so it is obvious at a glance how much of WEB-001 is not connected to anything, and a
 * story that typed its own address would hide one of the places the count comes from.
 */
const meta = {
  title: 'Onboarding/ON-01 Create organization',
  component: CreateOrganizationScreen,
  args: { signedInAs: FIXTURE_SIGNED_IN_AS, client: refusingClient() },
} satisfies Meta<typeof CreateOrganizationScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
