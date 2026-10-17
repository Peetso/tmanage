import type { Meta, StoryObj } from '@storybook/react-vite';
import { CopilotAnswerView } from '../src/components/screens/CopilotAnswerView';
import { copilotClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **AI copilot answer view (module 16).** Seeded with a question so the view opens straight onto a
 * resolved answer — the three regions the module map requires (the answer with its provider named,
 * the evidence each linking to its in-app source, the permission boundary) and the read-only
 * next-safe-action. The provider is the offline `local-stub`, shown as such, so the baseline can
 * never be mistaken for a live-model answer.
 */
const meta = {
  title: 'VR/Copilot answer',
  component: CopilotAnswerView,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    initialQuestion: 'What is blocked this week?',
    client: copilotClient(),
  },
} satisfies Meta<typeof CopilotAnswerView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Answer: Story = {};
