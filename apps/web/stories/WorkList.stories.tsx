import type { Meta, StoryObj } from '@storybook/react-vite';
import { WorkListScreen } from '../src/components/screens/WorkListScreen';
import { ARABIC_STORY } from './support/arabic';
import { WORK_NOW, workListClient } from './support/work-list-fixtures';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * **Work area v2 — the Works list and board** (W-WEB-2; Figma `WV2-01 Works list` `930:95062`,
 * AR `930:95514`, phones `930:95709` / `930:95904`; states `WV2-09` `938:99459`…; board `WV2-10`
 * `939:101782`, AR `939:102379`). The header, the five views, the five filters, the rows with
 * several doers, a supervisor, a client and a stage; the board's columns are the project's stage
 * set, or the four groups for all projects.
 */
const meta = {
  title: 'Work/Works list',
  component: WorkListScreen,
  tags: ['vr'],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    now: WORK_NOW,
    client: workListClient(),
  },
} satisfies Meta<typeof WorkListScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All work: ten works across three projects. */
export const Filled: Story = {};

/** The same list in real Arabic. */
export const FilledArabic: Story = { ...ARABIC_STORY };

/** The phone frame: rows as two lines, views and filters scroll sideways. */
export const Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** No work yet: one sentence and "New work". */
export const Empty: Story = { args: { client: workListClient('empty') } };

/** The first read has not answered: skeleton rows under the real header. */
export const Loading: Story = { args: { client: workListClient('loading') } };

/** The read failed: one calm sentence and "Try again". */
export const Failed: Story = { args: { client: workListClient('error') } };

/** TManage cannot be reached: the calm "check your connection" state (Figma W9 `938:101234`). */
export const Offline: Story = { args: { client: workListClient('offline') } };

/** The board of one project: its Design thinking stages are the columns. */
export const ProjectBoard: Story = {
  args: { initialView: 'board', initialProjectId: 'proj-1' },
};

/** The board of all projects in Arabic: the four groups, each card with its own stage. */
export const AllProjectsBoardArabic: Story = {
  ...ARABIC_STORY,
  args: { initialView: 'board' },
};

/** The project board on a phone: the columns become tabs that scroll sideways. */
export const ProjectBoardPhone: Story = {
  args: { initialView: 'board', initialProjectId: 'proj-1' },
  globals: { viewport: { value: PHONE_VIEWPORT } },
};
