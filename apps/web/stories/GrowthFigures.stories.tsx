import type { Meta, StoryObj } from '@storybook/react-vite';
import { GrowthFigures } from '../src/components/platform/activity/GrowthFigures';
import type { GrowthFigures as Figures } from '../src/lib/api/platform-growth';

/**
 * **Growth tiles** (62-A3, B14; FIGMA-D 758:43241 EN / 758:43432 AR with `direction: rtl`): the
 * Activation, AI and Money tiles the Platform admin Growth page draws first. Two states: a stack
 * with figures, and a young one where every tile says what it lacks ("No data yet", "Not set",
 * not in the free beta) instead of a 0. The tiles take their figures as props, so no stub client.
 */
const meta = {
  title: 'Platform/Growth figures',
  component: GrowthFigures,
  tags: ['vr'],
} satisfies Meta<typeof GrowthFigures>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Fixed, so the "this month" captions never move with the machine's clock. */
const NOW = new Date('2026-11-19T09:00:00.000Z');

const FILLED: Figures = {
  weeklyActiveCompanies: { weekStart: '2026-11-16', active: 18, companies: 42 },
  firstProjectFinished: { within30d: 0.31, within60d: 0.47 },
  timeToFirstOutcomeP50Hours: 52,
  ai: { month: '2026-11-01', tasksRun: 240, tasksCompleted: 221, creditsUsed: 61, creditsCap: 100 },
  costPerActiveCompany: { available: true, month: '2026-11-01', cents: 412 },
  margin: { available: false, reason: 'beta_free' },
};

const YOUNG: Figures = {
  weeklyActiveCompanies: null,
  firstProjectFinished: { within30d: null, within60d: null },
  timeToFirstOutcomeP50Hours: null,
  ai: {
    month: '2026-11-01',
    tasksRun: null,
    tasksCompleted: null,
    creditsUsed: null,
    creditsCap: 100,
  },
  costPerActiveCompany: { available: false, reason: 'not_set' },
  margin: { available: false, reason: 'beta_free' },
};

export const Filled: Story = { args: { figures: FILLED, now: NOW } };

export const NoDataYet: Story = { args: { figures: YOUNG, now: NOW } };
