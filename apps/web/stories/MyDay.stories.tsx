import type { Meta, StoryObj } from '@storybook/react-vite';
import { MyDayScreen } from '../src/components/screens/MyDayScreen';
import { SCREEN_VIEWPORTS } from '../.storybook/vr-viewport';
import { ARABIC_STORY } from './support/arabic';
import { MY_DAY_NOW, installMyDayFetch, myDayClient } from './support/my-day-fixtures';
import type { MyDaySeedOptions } from './support/my-day-fixtures';

/**
 * **My Day v3.1** (Figma section 822:65257): busy EN 823:1312, AR 824:322, EN dark 823:2602, AR
 * dark 824:982 (the `dark` variant of the two busy stories). Every widget reads the busy seed
 * through the screen's client; the title row's Help, AI, timer capsule and + New read the same
 * seed through the browser client. Shot at the design's 1440 px width.
 */
const DESIGN_VIEWPORT = 'design1440';

const meta = {
  title: 'Home/My Day v3',
  component: MyDayScreen,
  tags: ['vr'],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Atlas Studio',
    now: MY_DAY_NOW,
    client: myDayClient(),
  },
  parameters: {
    viewport: {
      options: {
        ...SCREEN_VIEWPORTS,
        [DESIGN_VIEWPORT]: {
          name: 'Design (1440 × 1500)',
          styles: { width: '1440px', height: '1500px' },
          type: 'desktop',
        },
      },
    },
  },
  globals: { viewport: { value: DESIGN_VIEWPORT } },
  beforeEach: (context) =>
    installMyDayFetch((context.parameters['myDaySeed'] as MyDaySeedOptions | undefined) ?? {}),
} satisfies Meta<typeof MyDayScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 823:1312 — a busy day: two late, three waiting on you, a timer at 00:42. */
export const Busy: Story = {};

/** 824:322 — the same day in Arabic (Fable R3: «التالي» heads the Next card). */
export const BusyArabic: Story = {
  ...ARABIC_STORY,
  args: { client: myDayClient({ lang: 'ar' }) },
  parameters: { myDaySeed: { lang: 'ar' } },
};

/** A new member: no projects yet, so Next offers the first task and the lists collapse. */
export const NewMember: Story = {
  args: { client: myDayClient({ variant: 'empty' }) },
  parameters: { myDaySeed: { variant: 'empty' } },
};
