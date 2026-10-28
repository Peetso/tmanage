import type { Meta, StoryObj } from '@storybook/react-vite';
import { PortalMilestonesScreen } from '../src/components/screens/PortalMilestonesScreen';
import { portalMilestonesClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Client portal — Timeline / milestones (x139).** The milestone half of the portal's Timeline
 * tab, rendered in the client portal shell (the client's name leads, the delivery team is the
 * "delivered by" line). The first shared project is auto-selected and its published milestones are
 * shown in order, so the baseline covers both the portal shell chrome and a populated milestone
 * list.
 */
const meta = {
  title: 'VR/Portal milestones',
  component: PortalMilestonesScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    clientName: 'Meridian Health',
    // Not the shell's fixture name ('Northstar Studio'), which the header holds back as sample
    // data; a story has no session to read the real name from, so it brings its own.
    providerName: 'Harbor & Pine Studio',
    client: portalMilestonesClient(),
  },
} satisfies Meta<typeof PortalMilestonesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Timeline: Story = {};
