import type { Meta, StoryObj } from '@storybook/react-vite';
import { OperatingTemplateScreen } from '../src/components/screens/OperatingTemplateScreen';
import { FIXTURE_SIGNED_IN_AS } from '../src/lib/fixtures';

/**
 * **ON-02 Choose operating template.**
 *
 * The one onboarding screen with no transport at all — every template, and the state lists
 * behind them, come from `@tmanage/domain`. That makes it the screen a story is most obviously
 * right for: there is nothing to stub, and what it draws is the real work and deliverable
 * machines from `23-ERD-AND-STATE-MACHINES`, not a retyped copy that would drift.
 */
const meta = {
  title: 'Onboarding/ON-02 Operating template',
  component: OperatingTemplateScreen,
  args: { signedInAs: FIXTURE_SIGNED_IN_AS },
} satisfies Meta<typeof OperatingTemplateScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
