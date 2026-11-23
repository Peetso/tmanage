import type { Meta, StoryObj } from '@storybook/react-vite';
import { PreferencesScreen } from '../src/components/screens/PreferencesScreen';
import { QuietHoursScreen } from '../src/components/screens/QuietHoursScreen';
import {
  profilePreferencesClient,
  quietHoursClient,
  withStillAppRouter,
  withStoredDisplayPreferences,
  withStubbedNetwork,
} from './support/vr-fixtures';

/**
 * **Preferences (module 20).** The two per-member preference forms, each seeded from the server's
 * stored rows so the baseline is the loaded state rather than the defaults or an error: profile &
 * preferences (profile, language, time zone, two-step) and the quiet-hours do-not-disturb window.
 */
const meta = {
  title: 'VR/Preferences',
  tags: ['vr'],
  decorators: [withStubbedNetwork],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Profile & preferences, seeded from the stored profile, display row and enrolled factors. */
export const Appearance: Story = {
  // The screen's unsaved-changes guard (QA-FIX-R, cec9c071) calls `useRouter()`.
  decorators: [withStoredDisplayPreferences, withStillAppRouter],
  render: () => (
    <PreferencesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={profilePreferencesClient()}
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
