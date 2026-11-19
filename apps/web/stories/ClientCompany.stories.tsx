import type { Meta, StoryObj } from '@storybook/react-vite';
import { ClientCompanyScreen } from '../src/components/screens/ClientCompanyScreen';
import {
  CLIENT_SUMMARY_NO_FINANCE,
  OVERVIEW_NOW,
  overviewClient,
} from './support/overview-fixtures';

/**
 * **ONEPAGE client company** (B04; Figma 740:40765, AR 740:41300 with `direction: rtl`, phone
 * 740:41828 / 740:42254 at a phone viewport). Overview draws the client summary's blocks; the
 * Projects tab can be narrowed to the projects at risk, the Risks card's hand-off.
 */
const meta = {
  title: 'Clients/ONEPAGE client company',
  component: ClientCompanyScreen,
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Atlas Studio',
    clientOrganizationId: 'co-cedar',
    now: () => OVERVIEW_NOW.getTime(),
    client: overviewClient({}),
  },
} satisfies Meta<typeof ClientCompanyScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

/** Without finance access: no Money card, no Time card, no overdue-invoice risk. */
export const OverviewWithoutFinance: Story = {
  args: { client: overviewClient({ clientSummary: CLIENT_SUMMARY_NO_FINANCE }) },
};

export const ProjectsAtRisk: Story = {
  args: { view: 'projects', atRisk: true },
};

export const People: Story = {
  args: { view: 'people' },
};
