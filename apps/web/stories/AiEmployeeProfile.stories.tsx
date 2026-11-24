import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { AiProfileScreen } from '../src/components/ai-employees/AiProfileScreen';
import { ARABIC_STORY } from './support/arabic';
import { asOwner } from './support/as-owner';
import {
  AI_CAST_AR,
  AI_CAST_EN,
  AI_NOW,
  ROTATED_KEY,
  aiEmployeesClient,
  aiView,
} from './support/ai-employee-fixtures';

/**
 * **AI employee profile** (plan 60 slice 60-07; design `ai-employees-figma/AI-S6…`): Mat's page
 * under People.
 *
 * - S6a Overview: About (each row edits in place) and Projects.
 * - S6b Connections: the Claude connector and an agent key, with Rotate and Revoke.
 * - S6c paused; S6d the revoke confirm; S6e0 the ⋯ menu with Retire in the danger colour; S6e the
 *   retire confirm; S6f a rotated key shown once; S6g Nour, not connected yet.
 *
 * Names are data, so the Arabic stories use the Arabic designs' names (زياد for Mat).
 */
const ADDRESS = 'https://tmanageapp.com/mcp';
const MAT_EN = aiView(AI_CAST_EN);
const MAT_AR = aiView(AI_CAST_AR);

const meta = {
  title: 'People/AI employee profile',
  component: AiProfileScreen,
  tags: ['vr'],
  decorators: [asOwner],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    ai: MAT_EN,
    client: aiEmployeesClient({ cast: AI_CAST_EN }),
    now: AI_NOW,
    addressOverride: ADDRESS,
  },
} satisfies Meta<typeof AiProfileScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const PHONE = { globals: { viewport: { value: PHONE_VIEWPORT } } } as const;
const PHONE_AR = {
  ...ARABIC_STORY,
  globals: { ...ARABIC_STORY.globals, viewport: { value: PHONE_VIEWPORT } },
};
const ARABIC_ARGS = { ai: MAT_AR, client: aiEmployeesClient({ cast: AI_CAST_AR }) };

/** S6a: Overview. */
export const Overview: Story = {};
export const OverviewArabic: Story = { ...ARABIC_STORY, args: ARABIC_ARGS };
export const OverviewPhone: Story = { ...PHONE };
export const OverviewPhoneArabic: Story = { ...PHONE_AR, args: ARABIC_ARGS };

/** S6a: one About row open for editing (the job title). */
export const EditingJobTitle: Story = { args: { initialEditing: 'jobTitle' } };

/** S6b: Connections. */
export const Connections: Story = { args: { initialTab: 'connections' } };
export const ConnectionsArabic: Story = {
  ...ARABIC_STORY,
  args: { ...ARABIC_ARGS, initialTab: 'connections' },
};
export const ConnectionsPhone: Story = { ...PHONE, args: { initialTab: 'connections' } };
export const ConnectionsPhoneArabic: Story = {
  ...PHONE_AR,
  args: { ...ARABIC_ARGS, initialTab: 'connections' },
};

/** S6c: paused by hand: the alert and Resume. */
export const Paused: Story = {
  args: { ai: aiView(AI_CAST_EN, { status: 'paused', pausedReason: 'manual' }) },
};
export const PausedPhoneArabic: Story = {
  ...PHONE_AR,
  args: { ...ARABIC_ARGS, ai: aiView(AI_CAST_AR, { status: 'paused', pausedReason: 'manual' }) },
};

/** S6c: paused because his sponsor left: pick a new sponsor. */
export const PausedSponsorLeft: Story = {
  args: { ai: aiView(AI_CAST_EN, { status: 'paused', pausedReason: 'sponsor_left' }) },
};

/** S6d: Revoke the agent key? */
export const RevokeConfirm: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialTab: 'connections',
    initialConnectionDialog: { kind: 'revoke', connectionId: 'key-1' },
  },
};
export const RevokeConfirmPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    ...ARABIC_ARGS,
    initialTab: 'connections',
    initialConnectionDialog: { kind: 'revoke', connectionId: 'key-1' },
  },
};

/** S6e0: the ⋯ menu, Retire in the danger colour. */
export const RetireMenu: Story = { args: { initialMenuOpen: true } };
export const RetireMenuPhoneArabic: Story = {
  ...PHONE_AR,
  args: { ...ARABIC_ARGS, initialMenuOpen: true },
};

/** S6e: Retire Mat? */
export const RetireConfirm: Story = { tags: ['vr-fullpage'], args: { initialRetire: true } };
export const RetireConfirmPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: { ...ARABIC_ARGS, initialRetire: true },
};

/** S6f: the rotated key, shown once. */
export const RotatedKey: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialTab: 'connections',
    initialConnectionDialog: { kind: 'rotated', key: ROTATED_KEY },
  },
};
export const RotatedKeyPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    ...ARABIC_ARGS,
    initialTab: 'connections',
    initialConnectionDialog: { kind: 'rotated', key: ROTATED_KEY },
  },
};

const NOUR = (cast: typeof AI_CAST_EN) =>
  aiView(cast, {
    id: 'ai-nour',
    membershipId: 'm-nour',
    displayName: cast.nour[0],
    jobTitle: cast.nour[1],
    connection: { live: 0, lastCalledAt: null },
  });

/** S6g: Nour is not connected yet: Connect. */
export const ConnectionsNone: Story = {
  args: {
    ai: NOUR(AI_CAST_EN),
    initialTab: 'connections',
    client: aiEmployeesClient({ cast: AI_CAST_EN, connections: 'none' }),
  },
};
export const ConnectionsNonePhoneArabic: Story = {
  ...PHONE_AR,
  args: {
    ai: NOUR(AI_CAST_AR),
    initialTab: 'connections',
    client: aiEmployeesClient({ cast: AI_CAST_AR, connections: 'none' }),
  },
};

/** A retired AI employee: read-only, with the date. */
export const Retired: Story = {
  args: {
    ai: aiView(AI_CAST_EN, {
      status: 'retired',
      retiredAt: '2026-11-24T09:00:00.000Z',
      canEdit: false,
      canPause: false,
      canResume: false,
      canRetire: false,
      connection: { live: 0, lastCalledAt: null },
    }),
  },
};
