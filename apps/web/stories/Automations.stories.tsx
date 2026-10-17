import type { Meta, StoryObj } from '@storybook/react-vite';
import { AutomationTemplatesScreen } from '../src/components/screens/AutomationTemplatesScreen';
import { AutomationSchedulesScreen } from '../src/components/screens/AutomationSchedulesScreen';
import {
  automationSchedulesClient,
  automationTemplatesClient,
  withStubbedNetwork,
} from './support/vr-fixtures';

/**
 * **Automations & integrations (module 17).** The two list surfaces an admin reads: the workflow
 * templates (a trigger paired with an action, with its enabled state) and the scheduled triggers
 * (the interval each template runs on and when it next fires). Both are gated on `org.manage`; the
 * mocked clients render the populated tables the baseline exists to hold steady.
 */
const meta = {
  title: 'VR/Automations',
  tags: ['vr'],
  decorators: [withStubbedNetwork],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The workflow templates table — one enabled template and one disabled. */
export const Templates: Story = {
  render: () => (
    <AutomationTemplatesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={automationTemplatesClient()}
    />
  ),
};

/** The scheduled triggers table — a daily and a weekly schedule. */
export const Schedules: Story = {
  render: () => (
    <AutomationSchedulesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={automationSchedulesClient()}
    />
  ),
};
