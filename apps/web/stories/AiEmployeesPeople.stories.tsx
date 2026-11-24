import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { ARABIC_STORY } from './support/arabic';
import { asOwner } from './support/as-owner';
import {
  AI_CAST_AR,
  AI_CAST_EN,
  AI_NOW,
  ROTATED_KEY,
  aiEmployeesClient,
  aiView,
  type AiCast,
  type AiScene,
} from './support/ai-employee-fixtures';
import { markVrReady, waitForElement } from './support/vr-fixtures';

/**
 * **AI employees on People** (plan 60 slice 60-07; design `ai-employees-figma/AI-S1…S4`).
 *
 * - S1: People with Everyone / People / AI employees, the roster (Name, Job title, Role, Sponsor,
 *   Status) and the phone list; S1b the empty AI tab; S1c Mat retired and dimmed; S1d the
 *   "switched off" banner.
 * - S2: Add asks "Invite a person" or "Hire an AI employee"; S2b the AI card at the beta limit.
 * - S3: the hire wizard's Who and Work steps; S3c the missing name; S3d the close confirm; S3e an
 *   info popover open.
 * - S4: Connect (Claude, an agent key's expiry, the key shown once) and Test (waiting, ready, not
 *   called).
 *
 * Names are data, so the Arabic stories use the Arabic designs' names (زياد for Mat).
 */
const ADDRESS = 'https://tmanageapp.com/mcp';

const client = (cast: AiCast, scene: AiScene = 'normal', polled?: ReturnType<typeof aiView>) =>
  aiEmployeesClient({ cast, scene, ...(polled === undefined ? {} : { polled }) });

const meta = {
  title: 'People/AI employees',
  component: PeopleDirectoryScreen,
  tags: ['vr'],
  decorators: [asOwner],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: client(AI_CAST_EN),
    addressOverride: ADDRESS,
  },
} satisfies Meta<typeof PeopleDirectoryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const PHONE = { globals: { viewport: { value: PHONE_VIEWPORT } } } as const;
const PHONE_AR = {
  ...ARABIC_STORY,
  globals: { ...ARABIC_STORY.globals, viewport: { value: PHONE_VIEWPORT } },
};

/* ── S1 People ── */

/** S1: everyone, five people and three AI employees. */
export const People: Story = {};
export const PeopleArabic: Story = { ...ARABIC_STORY, args: { client: client(AI_CAST_AR) } };
export const PeoplePhone: Story = { ...PHONE };
export const PeoplePhoneArabic: Story = { ...PHONE_AR, args: { client: client(AI_CAST_AR) } };

/** S1b: the AI employees tab before anyone is hired. */
export const EmptyAiTab: Story = {
  args: { initialTab: 'ai', client: client(AI_CAST_EN, 'empty') },
};
export const EmptyAiTabPhoneArabic: Story = {
  ...PHONE_AR,
  args: { initialTab: 'ai', client: client(AI_CAST_AR, 'empty') },
};

/** S1c: Mat retired, his row dimmed with "Retired". */
export const AfterRetire: Story = { args: { client: client(AI_CAST_EN, 'retired') } };
export const AfterRetirePhoneArabic: Story = {
  ...PHONE_AR,
  args: { client: client(AI_CAST_AR, 'retired') },
};

/** S1d: AI employees switched off in Settings: the banner. */
export const SwitchedOff: Story = { args: { client: client(AI_CAST_EN, 'off') } };
export const SwitchedOffPhoneArabic: Story = {
  ...PHONE_AR,
  args: { client: client(AI_CAST_AR, 'off') },
};

/* ── S2 Add ── */

/** S2: Add asks which kind of member. */
export const AddChooser: Story = { tags: ['vr-fullpage'], args: { initialDialog: 'add' } };
export const AddChooserArabic: Story = {
  ...ARABIC_STORY,
  tags: ['vr-fullpage'],
  args: { initialDialog: 'add', client: client(AI_CAST_AR) },
};
export const AddChooserPhone: Story = {
  ...PHONE,
  tags: ['vr-fullpage'],
  args: { initialDialog: 'add' },
};

/** S2b: five of five used: the AI card is unavailable and says why. */
export const AddChooserAtLimit: Story = {
  tags: ['vr-fullpage'],
  args: { initialDialog: 'add', client: client(AI_CAST_EN, 'limit') },
};
export const AddChooserAtLimitPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: { initialDialog: 'add', client: client(AI_CAST_AR, 'limit') },
};

/* ── S3 Wizard ── */

const WHO_EN = {
  name: 'Mat',
  jobTitle: 'Social media designer',
  departmentKey: 'marketing',
  vendorLabel: 'Claude',
};
const WHO_AR = {
  name: 'زياد',
  jobTitle: 'مصمم سوشيال ميديا',
  departmentKey: 'marketing',
  vendorLabel: 'Claude',
};
const WORK = { role: 'member', projectIds: ['p-web', 'p-nile'], sponsorMembershipId: 'm-peter' };

/** S3a: step 1, Who. */
export const WizardWho: Story = {
  tags: ['vr-fullpage'],
  args: { initialDialog: 'hire', initialWizard: { step: 1, who: WHO_EN } },
};
export const WizardWhoArabic: Story = {
  ...ARABIC_STORY,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 1, who: WHO_AR },
    client: client(AI_CAST_AR),
  },
};
export const WizardWhoPhone: Story = {
  ...PHONE,
  tags: ['vr-fullpage'],
  args: { initialDialog: 'hire', initialWizard: { step: 1, who: WHO_EN } },
};

/** S3b: step 2, Work: two projects, one a client's, so the client alert shows. */
export const WizardWork: Story = {
  tags: ['vr-fullpage'],
  args: { initialDialog: 'hire', initialWizard: { step: 2, who: WHO_EN, work: WORK } },
};
export const WizardWorkArabic: Story = {
  ...ARABIC_STORY,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 2, who: WHO_AR, work: WORK },
    client: client(AI_CAST_AR),
  },
};
export const WizardWorkPhone: Story = {
  ...PHONE,
  tags: ['vr-fullpage'],
  args: { initialDialog: 'hire', initialWizard: { step: 2, who: WHO_EN, work: WORK } },
};

/** S3c: Next with no name: the error under the name. */
export const WizardNameError: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 1, who: { ...WHO_EN, name: '' }, whoProblems: ['nameNeeded'] },
  },
};
export const WizardNameErrorPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 1, who: { ...WHO_AR, name: '' }, whoProblems: ['nameNeeded'] },
    client: client(AI_CAST_AR),
  },
};

const HIRED_EN = aiView(AI_CAST_EN, { connection: { live: 0, lastCalledAt: null } });
const HIRED_AR = aiView(AI_CAST_AR, { connection: { live: 0, lastCalledAt: null } });

/** S3d: closing after the hire, before he is connected. */
export const WizardCloseConfirm: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_EN, work: WORK, hired: HIRED_EN, confirmClose: true },
  },
};
export const WizardCloseConfirmPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_AR, work: WORK, hired: HIRED_AR, confirmClose: true },
    client: client(AI_CAST_AR),
  },
};

/** S3e: the Role info popover open on step 2. */
export const WizardInfoPopover: Story = {
  tags: ['vr-fullpage', 'vr-play'],
  args: { initialDialog: 'hire', initialWizard: { step: 2, who: WHO_EN, work: WORK } },
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.body;
    const info = await waitForElement<HTMLButtonElement>(
      root,
      'dialog .tm-aie-label button[aria-expanded]',
    );
    info.click();
    await waitForElement(root, 'dialog .tm-aie-label button[aria-expanded="true"]');
    markVrReady();
  },
};

/* ── S4 Connect and Test ── */

/** S4a: Connect with Claude: the address and three steps. */
export const ConnectClaude: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_EN, work: WORK, hired: HIRED_EN, connect: 'claude' },
  },
};
export const ConnectClaudeArabic: Story = {
  ...ARABIC_STORY,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_AR, work: WORK, hired: HIRED_AR, connect: 'claude' },
    client: client(AI_CAST_AR),
  },
};
export const ConnectClaudePhone: Story = {
  ...PHONE,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_EN, work: WORK, hired: HIRED_EN, connect: 'claude' },
  },
};

/** S4b0: another agent: choose how long the key lives, then Create key. */
export const ConnectKeyExpiry: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_EN, work: WORK, hired: HIRED_EN, connect: 'other' },
  },
};
export const ConnectKeyExpiryPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: { step: 3, who: WHO_AR, work: WORK, hired: HIRED_AR, connect: 'other' },
    client: client(AI_CAST_AR),
  },
};

/** S4b: the key shown once, with "copy it now". */
export const ConnectKeyShown: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: {
      step: 3,
      who: WHO_EN,
      work: WORK,
      hired: HIRED_EN,
      connect: 'other',
      createdKey: ROTATED_KEY,
    },
  },
};
export const ConnectKeyShownPhoneArabic: Story = {
  ...PHONE_AR,
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire',
    initialWizard: {
      step: 3,
      who: WHO_AR,
      work: WORK,
      hired: HIRED_AR,
      connect: 'other',
      createdKey: ROTATED_KEY,
    },
    client: client(AI_CAST_AR),
  },
};

const stopped = () => AI_NOW;
const CALLED_EN = aiView(AI_CAST_EN, {
  createdAt: new Date(AI_NOW - 60_000).toISOString(),
  connection: { live: 1, lastCalledAt: new Date(AI_NOW - 5_000).toISOString() },
});
const CALLED_AR = aiView(AI_CAST_AR, {
  createdAt: new Date(AI_NOW - 60_000).toISOString(),
  connection: { live: 1, lastCalledAt: new Date(AI_NOW - 5_000).toISOString() },
});
const CONNECTED_EN = aiView(AI_CAST_EN, { connection: { live: 1, lastCalledAt: null } });
const CONNECTED_AR = aiView(AI_CAST_AR, { connection: { live: 1, lastCalledAt: null } });

const testStory = (
  cast: AiCast,
  who: typeof WHO_EN,
  hired: ReturnType<typeof aiView>,
  elapsed: number,
) => ({
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'hire' as const,
    initialWizard: {
      step: 4 as const,
      who,
      work: WORK,
      hired,
      testElapsedMs: elapsed,
      testClock: stopped,
    },
    client: client(cast, 'normal', hired),
  },
});

/** S4c: waiting for Mat's first call. */
export const TestWaiting: Story = testStory(AI_CAST_EN, WHO_EN, CONNECTED_EN, 12_000);
export const TestWaitingPhoneArabic: Story = {
  ...PHONE_AR,
  ...testStory(AI_CAST_AR, WHO_AR, CONNECTED_AR, 12_000),
};

/** S4d: connected and called: "Mat is ready for work". */
export const TestReady: Story = testStory(AI_CAST_EN, WHO_EN, CALLED_EN, 12_000);
export const TestReadyPhoneArabic: Story = {
  ...PHONE_AR,
  ...testStory(AI_CAST_AR, WHO_AR, CALLED_AR, 12_000),
};

/** S4e: two minutes and no call: Check again and Change connection. */
export const TestNotCalled: Story = testStory(AI_CAST_EN, WHO_EN, CONNECTED_EN, 125_000);
export const TestNotCalledPhoneArabic: Story = {
  ...PHONE_AR,
  ...testStory(AI_CAST_AR, WHO_AR, CONNECTED_AR, 125_000),
};
