import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { AiEmployeesSettingsScreen } from '../src/components/ai-employees/AiEmployeesSettingsScreen';
import { ARABIC_STORY } from './support/arabic';
import { asOwner } from './support/as-owner';
import { AI_CAST_AR, AI_CAST_EN, aiEmployeesClient } from './support/ai-employee-fixtures';

/**
 * **Settings › AI employees** (plan 60 slice 60-07; design `ai-employees-figma/AI-S8…`): the
 * workspace switch with "3 of 5 used in the beta", who may hire and give work to AI, the client
 * work rules, and the projects closed to AI. S8b asks before switching AI employees off.
 */
const meta = {
  title: 'Settings/AI employees',
  component: AiEmployeesSettingsScreen,
  tags: ['vr'],
  decorators: [asOwner],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: aiEmployeesClient({ cast: AI_CAST_EN }),
  },
} satisfies Meta<typeof AiEmployeesSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const PHONE = { globals: { viewport: { value: PHONE_VIEWPORT } } } as const;
const PHONE_AR = {
  ...ARABIC_STORY,
  globals: { ...ARABIC_STORY.globals, viewport: { value: PHONE_VIEWPORT } },
};
const ARABIC_ARGS = { client: aiEmployeesClient({ cast: AI_CAST_AR }) };

/** S8: the settings. */
export const Settings: Story = {};
export const SettingsArabic: Story = { ...ARABIC_STORY, args: ARABIC_ARGS };
export const SettingsPhone: Story = { ...PHONE };
export const SettingsPhoneArabic: Story = { ...PHONE_AR, args: ARABIC_ARGS };

/** "Close a project to AI…" open. */
export const ClosingAProject: Story = { args: { initialClosing: true } };

/** S8b: Switch off AI employees? */
export const SwitchOffConfirm: Story = { tags: ['vr-fullpage'], args: { initialConfirmOff: true } };
export const SwitchOffConfirmPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: { ...ARABIC_ARGS, initialConfirmOff: true },
};
