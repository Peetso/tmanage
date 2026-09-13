import type { Meta, StoryObj } from '@storybook/react-vite';
import { FirstProjectScreen } from '../src/components/screens/FirstProjectScreen';
import { FIXTURE_SIGNED_IN_AS } from '../src/lib/fixtures';
import { emptyDirectoryClient } from './support/stub-client';

/**
 * **ON-03 First project.**
 *
 * It fetches the organization's workspaces as of PROJ-001 and cannot submit without one, so the
 * stub answers with a single workspace. `organizationSlug` comes from the route in the running
 * application; here it is the export's own name, so a story can be held beside the artboard
 * without a mental substitution.
 */
const meta = {
  title: 'Onboarding/ON-03 First project',
  component: FirstProjectScreen,
  args: {
    signedInAs: FIXTURE_SIGNED_IN_AS,
    organizationSlug: 'northstar',
    client: emptyDirectoryClient(),
  },
} satisfies Meta<typeof FirstProjectScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
