import type { Meta, StoryObj } from '@storybook/react-vite';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { ARABIC_STORY } from './support/arabic';
import { WORK_NOW, workClient } from './support/work-fixtures';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * **Work area v2 — the work page** (W-WEB-1; Figma `WV2-02 Work page` `933:95423`, AR with
 * `direction: rtl`, phone at a phone viewport, a new work `WV2-09`). One scroll: the title with
 * its voice control, the stage trail, Description, Steps, Files, Comments · Activity; the
 * properties panel on the end side, every row edited in place (no "Edit details" form).
 */
const meta = {
  title: 'Work/Work page',
  component: WorkItemDetailScreen,
  tags: ['vr'],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    workItemId: 'wi-1',
    now: WORK_NOW,
    client: workClient(),
  },
} satisfies Meta<typeof WorkItemDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page as the doer sees it: a supervised work in Prototype, two of five steps done. */
export const Filled: Story = {};

/** The same page in real Arabic. */
export const FilledArabic: Story = { ...ARABIC_STORY };

/** The phone frame: one column, the panel under the steps. */
export const Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** A work just made: every section stays, each with its one calm line. */
export const NewWork: Story = {
  args: {
    client: workClient({
      fresh: true,
      item: {
        title: 'Plan the launch email',
        description: null,
        audience: 'internal',
        dueAt: null,
        stageId: 'st-empathize',
        stageName: 'Empathize',
        state: 'ready',
      },
    }),
  },
};
