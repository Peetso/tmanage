import type { Meta, StoryObj } from '@storybook/react-vite';
import { AttackTrackerScreen } from '../src/components/platform/security/AttackTrackerScreen';
import { SCREEN_VIEWPORTS } from '../.storybook/vr-viewport';
import { ARABIC_STORY } from './support/arabic';
import { TRACKER_NOW, trackerClient } from './support/attack-tracker-fixtures';
import {
  markVrReady,
  startClockAt,
  waitForElement,
  withStubbedNetwork,
} from './support/vr-fixtures';

/**
 * **Platform admin › Security › Attack tracker** (SEC-TRACKER; Figma section 833:85442): EN light
 * 840:1578, AR light 840:906, EN dark 840:2243 (the `dark` variant of `Default`), the 1024 px
 * side sheet 840:2909 and the state frames 841:906 / 841:1622 (row menu, dialogs, quiet, error).
 * Every read is answered from `support/attack-tracker-fixtures.ts`; every write succeeds.
 */
const DESIGN_VIEWPORT = 'design1440';
const SHEET_VIEWPORT = 'design1024';

const meta = {
  title: 'Platform/Attack tracker',
  component: AttackTrackerScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        ...SCREEN_VIEWPORTS,
        [DESIGN_VIEWPORT]: {
          name: 'Design (1440 × 1845)',
          styles: { width: '1440px', height: '1845px' },
          type: 'desktop',
        },
        [SHEET_VIEWPORT]: {
          name: 'Design (1024 × 900)',
          styles: { width: '1024px', height: '900px' },
          type: 'desktop',
        },
      },
    },
  },
  globals: { viewport: { value: DESIGN_VIEWPORT } },
  args: { client: trackerClient(), now: () => TRACKER_NOW },
  // The step-up pill counts its minutes from Date.now(): start it at the fixtures' noon.
  beforeEach: () => startClockAt(TRACKER_NOW),
} satisfies Meta<typeof AttackTrackerScreen>;

export default meta;
type Story = StoryObj<typeof meta>;
type Play = NonNullable<Story['play']>;

/** Click the first element matching `selector` once it is there, then mark the shot ready. */
function clickThen(selector: string, then?: string): Play {
  return async ({ canvasElement }) => {
    try {
      const target = await waitForElement<HTMLElement>(canvasElement, selector, 5_000);
      target.click();
      if (then) await waitForElement(document.body, then, 3_000);
    } catch {
      // The screen did not reach the control; the shot shows what did render.
    }
    markVrReady();
  };
}

/** Open the detail's (or a row's) action, then wait for the dialog. */
function openDialog(find: (root: HTMLElement) => HTMLElement | null): Play {
  return async ({ canvasElement }) => {
    try {
      await waitForElement(canvasElement, '.tm-at-detail__address', 5_000);
      await waitForElement(canvasElement, '.tm-at-list', 5_000);
      find(canvasElement)?.click();
      await waitForElement(document.body, '.tm-at-dialog', 3_000);
    } catch {
      // As above.
    }
    markVrReady();
  };
}

function buttonNamed(root: HTMLElement, name: string): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('button')].find(
      (button) => button.textContent?.trim() === name,
    ) ?? null
  );
}

function rowMenu(root: HTMLElement, row: number): HTMLElement | null {
  return root.querySelectorAll<HTMLElement>('.tm-at-menu > button')[row] ?? null;
}

/** 840:1578 — the week: eight sources, the critical one open beside the list. */
export const Default: Story = {};

/** 840:906 — the same week in Arabic, right to left. */
export const Arabic: Story = {
  ...ARABIC_STORY,
  args: { client: trackerClient({ lang: 'ar' }) },
};

/** 840:2909 — at 1024 px the list takes the width and a row opens the detail as a side sheet. */
export const SideSheet1024: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  globals: { viewport: { value: SHEET_VIEWPORT } },
  play: clickThen('.tm-at-address', '.tm-at-sheet .tm-at-detail__address'),
};

/** 841:1622 — a quiet week. */
export const Quiet: Story = {
  args: { client: trackerClient({ variant: 'quiet' }) },
};

/** 841:1622 — the list could not be read. */
export const CouldNotLoad: Story = {
  args: { client: trackerClient({ variant: 'list-error' }) },
};

/** 841:1622 — loading. Not shot: the harness waits for every skeleton to clear. */
export const Loading: Story = {
  tags: ['!vr'],
  args: { client: trackerClient({ variant: 'loading' }) },
};

/** 841:906 states — the row's "…": Add to allowlist, Mark as known tester, then Block last. */
export const RowMenu: Story = {
  tags: ['vr-play'],
  play: clickThen('.tm-at-menu > button', '.tm-at-menu__list'),
};

/** 841:906 states — Block this address? */
export const BlockDialog: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: openDialog((root) => buttonNamed(root, 'Block source')),
};

/** 841:906 states — blocking an allowlisted source is refused and names the entry (row 7, the tester). */
export const BlockAllowlisted: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: async (context) => {
    const { canvasElement } = context;
    try {
      await waitForElement(canvasElement, '.tm-at-list', 5_000);
      rowMenu(canvasElement, 6)?.click();
      await waitForElement(canvasElement, '.tm-at-menu__list', 3_000);
      buttonNamed(canvasElement, 'Block source')?.click();
      await waitForElement(document.body, '.tm-at-dialog', 3_000);
    } catch {
      // As above.
    }
    markVrReady();
  },
};

/** Fable build rule 1 — Add to allowlist on a blocked source (row 2) is refused. */
export const AllowBlocked: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: async ({ canvasElement }) => {
    try {
      await waitForElement(canvasElement, '.tm-at-list', 5_000);
      rowMenu(canvasElement, 1)?.click();
      await waitForElement(canvasElement, '.tm-at-menu__list', 3_000);
      buttonNamed(canvasElement, 'Add to allowlist')?.click();
      await waitForElement(document.body, '.tm-at-dialog', 3_000);
    } catch {
      // As above.
    }
    markVrReady();
  },
};

/** 841:906 states — Add to the allowlist from the card. */
export const AllowAdd: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: openDialog((root) => buttonNamed(root, 'Add')),
};

/** 841:906 states — turning the sign-in door off asks first. */
export const DoorOff: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: openDialog((root) => root.querySelector<HTMLElement>('.tm-at-door__switch input')),
};

/** 841:906 states — the accounts the source targeted. */
export const Accounts: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: openDialog((root) => root.querySelector<HTMLElement>('.tm-at-fact .tm-at-link')),
};

/** 841:906 states — sign the account that got in out everywhere (with the reason the API keeps). */
export const SignOut: Story = {
  tags: ['vr-play', 'vr-fullpage'],
  play: openDialog((root) => buttonNamed(root, 'Sign this account out everywhere')),
};
