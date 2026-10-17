import type { Meta, StoryObj } from '@storybook/react-vite';
import { PreferencesScreen } from '../src/components/screens/PreferencesScreen';
import { QuietHoursScreen } from '../src/components/screens/QuietHoursScreen';
import { preferencesClient, quietHoursClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Preferences (module 20).** The two per-member preference forms, each seeded from the server's
 * stored row so the baseline is the loaded state rather than the defaults: appearance & language
 * (theme, locale, density) and the quiet-hours do-not-disturb window.
 */
const meta = {
  title: 'VR/Preferences',
  tags: ['vr'],
  decorators: [withStubbedNetwork],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Appearance & language, seeded from the stored preferences row. */
export const Appearance: Story = {
  render: () => (
    <PreferencesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={preferencesClient()}
    />
  ),
};

/** The quiet-hours window, seeded from the stored do-not-disturb row. */
export const QuietHours: Story = {
  render: () => (
    <QuietHoursScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={quietHoursClient()}
    />
  ),
};
