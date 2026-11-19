import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertSettingsScreen } from '../src/components/screens/AlertSettingsScreen';
import { alertsClient } from './support/alert-fixtures';
import { withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Settings → Alerts** (62-27, B12; FIGMA-D group c: the owner's eight rules, AR with
 * `direction: rtl`). The stub answers with the domain catalogue's defaults, Unusual expense off,
 * the fixtures `tests/alert-settings-screen.test.tsx` asserts on. Baselines are taken in the batch
 * test phase.
 */
const meta = {
  title: 'Settings/Alerts',
  component: AlertSettingsScreen,
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Atlas Studio',
    client: alertsClient(),
  },
} satisfies Meta<typeof AlertSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The owner: eight rules, money rules told to the finance team only. */
export const Owner: Story = {};

/** Phone: each rule a stacked block, Save sticks to the bottom (fix 32). */
export const Phone: Story = { parameters: { viewport: { defaultViewport: 'mobile1' } } };

/** Anyone but the owner (the route's 403). */
export const NotOwner: Story = { args: { client: alertsClient({ settings: 403 }) } };

/** The company's `business_briefing` flag is off (the route's 404). */
export const FlagOff: Story = { args: { client: alertsClient({ settings: null }) } };
