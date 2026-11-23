import type { Meta, StoryObj } from '@storybook/react-vite';
import { NewWorkDialog } from '../src/components/work/create/NewWorkDialog';
import { ARABIC_STORY } from './support/arabic';
import { WORK_NOW, workClient } from './support/work-fixtures';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * **Work area v2 — New work** (W-WEB-3; Figma `WV2-03` quick `934:97365`, `WV2-04` full
 * `935:97514`, phone sheet `934:98215` and page `935:98783`). The name with voice naming, then
 * the work page's properties in its order and words: chips in quick create, rows in full create
 * with Steps, Description and More. Opened on the project the person was looking at.
 */
const meta = {
  title: 'Work/New work',
  component: NewWorkDialog,
  tags: ['vr', 'vr-fullpage'],
  args: {
    organizationSlug: 'northstar',
    projectId: 'proj-1',
    draft: { title: 'Design the landing page', note: '' },
    now: WORK_NOW,
    client: workClient(),
    onClose: () => undefined,
    onCreated: () => undefined,
  },
} satisfies Meta<typeof NewWorkDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Quick create under the header's New work: the name and six chips. */
export const Quick: Story = {};

/** Full create: the six rows, Steps, Description and More. */
export const Full: Story = { args: { mode: 'full' } };

/** Full create in real Arabic. */
export const FullArabic: Story = { ...ARABIC_STORY, args: { mode: 'full' } };

/** Phone: quick create as a bottom sheet. */
export const PhoneQuick: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};
