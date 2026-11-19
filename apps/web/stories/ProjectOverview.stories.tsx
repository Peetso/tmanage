import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectOverviewScreen } from '../src/components/screens/ProjectOverviewScreen';
import {
  ACTIVITY_EMPTY,
  ACTIVITY_PAGE_NO_FINANCE,
  OVERVIEW_NOW,
  PROJECT_SUMMARY_EMPTY,
  PROJECT_SUMMARY_NO_FINANCE,
  PROJECT_SUMMARY_WITH_SIGNALS,
  overviewClient,
} from './support/overview-fixtures';
import { ARABIC_STORY } from './support/arabic';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * **ONEPAGE project overview** (B04; Figma 739:40334, AR 739:40873 with `direction: rtl`, phone
 * 739:42354 at a phone viewport, no finance 739:41403). The stub answers the summary read with the
 * same fixtures `tests/overview-blocks.test.tsx` and `tests/project-overview-screen.test.tsx`
 * assert on. Visual baselines are taken in the batch test phase (the two screens only).
 */
const meta = {
  title: 'Projects/ONEPAGE project overview',
  component: ProjectOverviewScreen,
  // A [vr] screen since T2 (ONEPAGE baselines, BATCH-2026-11-19 section 6).
  tags: ['vr'],
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

/** T5 D10 — the same page in real Arabic (the catalogue, not only the direction). */
export const FilledArabic: Story = { ...ARABIC_STORY };

/** T5 D9 — the phone frame (739:42354), shot at 390 × 844. */
export const Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** A member without finance access: no Money card, no money figure in Time or Risks. */
export const WithoutFinance: Story = {
  args: { client: overviewClient({ projectSummary: PROJECT_SUMMARY_NO_FINANCE }) },
};

/** A new project: every card stays, each with its one calm line. */
export const Empty: Story = {
  args: { client: overviewClient({ projectSummary: PROJECT_SUMMARY_EMPTY }) },
};

/** B10 — `business_briefing` on: the open signals are more Risks lines, one per rule. */
export const WithSignals: Story = {
  args: { client: overviewClient({ projectSummary: PROJECT_SUMMARY_WITH_SIGNALS }) },
};

export const Loading: Story = {
  // A skeleton has no settled frame to shoot (the VR spec waits for it to clear).
  tags: ['!vr'],
  args: { client: overviewClient({ projectSummary: 'pending' }) },
};

export const LoadFailed: Story = {
  args: { client: overviewClient({ projectSummary: 'fail' }) },
};

/** B09 — the Activity tab (FIGMA-D 753:41712): day groups, kind chips, Person and date menus. */
export const Activity: Story = {
  args: { view: 'activity' },
};

/** T5 D10 — the Activity tab in real Arabic: «عمر عادل غيّر حالة «…»», names isolated. */
export const ActivityArabic: Story = {
  ...ARABIC_STORY,
  args: { view: 'activity' },
};

/** T5 D9 — the Activity tab on a phone: the tab row and the Filter button, at 390 × 844. */
export const ActivityPhone: Story = {
  args: { view: 'activity' },
  globals: { viewport: { value: PHONE_VIEWPORT } },
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
