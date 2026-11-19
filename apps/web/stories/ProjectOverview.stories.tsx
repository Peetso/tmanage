import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import {
  ACTIVITY_EMPTY,
  ACTIVITY_PAGE_NO_FINANCE,
  OVERVIEW_NOW,
  PROJECT_SUMMARY_EMPTY,
  PROJECT_SUMMARY_NO_FINANCE,
  overviewClient,
} from './support/overview-fixtures';

/**
 * **ONEPAGE project overview** (B04; Figma 739:40334, AR 739:40873 with `direction: rtl`, phone
 * 739:42354 at a phone viewport, no finance 739:41403). The stub answers the summary read with the
 * same fixtures `tests/overview-blocks.test.tsx` and `tests/project-overview-screen.test.tsx`
 * assert on. Visual baselines are taken in the batch test phase (the two screens only).
 */
const meta = {
  title: 'Projects/ONEPAGE project overview',
  component: ProjectOverviewScreen,
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Atlas Studio',
    projectId: 'proj-1',
    now: OVERVIEW_NOW,
    client: overviewClient({}),
  },
} satisfies Meta<typeof ProjectOverviewScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every block filled, as the owner sees it. */
export const Filled: Story = {};

/** A member without finance access: no Money card, no money figure in Time or Risks. */
export const WithoutFinance: Story = {
  args: { client: overviewClient({ projectSummary: PROJECT_SUMMARY_NO_FINANCE }) },
};

/** A new project: every card stays, each with its one calm line. */
export const Empty: Story = {
  args: { client: overviewClient({ projectSummary: PROJECT_SUMMARY_EMPTY }) },
};

export const Loading: Story = {
  args: { client: overviewClient({ projectSummary: 'pending' }) },
};

export const LoadFailed: Story = {
  args: { client: overviewClient({ projectSummary: 'fail' }) },
};

/** B09 — the Activity tab (FIGMA-D 753:41712): day groups, kind chips, Person and date menus. */
export const Activity: Story = {
  args: { view: 'activity' },
};

/** B09 — without finance access: no Money chip and no money line (review FIGMA-D fix 1). */
export const ActivityWithoutFinance: Story = {
  args: {
    view: 'activity',
    client: overviewClient({ activity: ACTIVITY_PAGE_NO_FINANCE, capabilities: ['work.read'] }),
  },
};

/** B09 — nothing happened yet (753:43120): "No activity yet" and "Go to work". */
export const ActivityEmpty: Story = {
  args: { view: 'activity', client: overviewClient({ activity: ACTIVITY_EMPTY }) },
};
