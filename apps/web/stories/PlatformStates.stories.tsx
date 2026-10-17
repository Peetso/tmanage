import type { Meta, StoryObj } from '@storybook/react-vite';
import { MaintenanceBanner } from '../src/components/screens/MaintenanceBanner';
import OfflinePage from '../src/app/offline/page';
import { MAINTENANCE_DEGRADED, MAINTENANCE_DOWN, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Platform states (x185).** The cross-cutting status surfaces the shell owns, baselined apart
 * from any one screen: the maintenance / degraded-mode banner (seeded through its `initialWindow`
 * seam so it renders without a fetch) at each severity it colours, and the offline fallback
 * document the service worker serves when a navigation cannot reach the network.
 */
const meta = {
  title: 'VR/Platform states',
  tags: ['vr'],
  decorators: [withStubbedNetwork],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The degraded-service banner: a word plus the colour, per token law. */
export const MaintenanceDegraded: Story = {
  render: () => <MaintenanceBanner initialWindow={MAINTENANCE_DEGRADED} />,
};

/** The full-maintenance (down) banner — the most severe surface. */
export const MaintenanceDown: Story = {
  render: () => <MaintenanceBanner initialWindow={MAINTENANCE_DOWN} />,
};

/** The offline fallback document — the shared state frame with its one re-try action. */
export const Offline: Story = {
  render: () => <OfflinePage />,
};
