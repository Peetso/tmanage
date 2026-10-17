import type { Meta, StoryObj } from '@storybook/react-vite';
import { InsightsPortfolioMobileSummary } from '../src/components/screens/InsightsPortfolioMobileSummary';
import { INSIGHTS_PORTFOLIO } from './support/vr-fixtures';

/**
 * **Insights portfolio — mobile companion (module 23).** The compact, read-only summary the
 * screen renders below its ~768px breakpoint in place of the dense table: three headline figures
 * and the projects carrying the most blocked work, each a drill-in link. It takes the same roll-up
 * the full screen already fetched as a prop, so a baseline needs no client — just the fixture.
 */
const meta = {
  title: 'VR/Insights portfolio mobile',
  component: InsightsPortfolioMobileSummary,
  tags: ['vr'],
  args: { portfolio: INSIGHTS_PORTFOLIO, organizationSlug: 'northstar' },
} satisfies Meta<typeof InsightsPortfolioMobileSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {};
