import type { Meta, StoryObj } from '@storybook/react-vite';
import { OperatingTemplateScreen } from '../src/components/screens/OperatingTemplateScreen';
import { FIXTURE_SIGNED_IN_AS } from '../src/lib/fixtures';

/**
 * **ON-02 Choose operating template.**
 *
 * Every template, and the state lists behind them, come from `@tmanage/domain`. The saved
 * template is read from the API; with none answering, the story shows the default choice.
 */
const meta = {
  title: 'Onboarding/ON-02 Operating template',
  component: OperatingTemplateScreen,
  args: { signedInAs: FIXTURE_SIGNED_IN_AS, organizationSlug: 'northstar' },
} satisfies Meta<typeof OperatingTemplateScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
