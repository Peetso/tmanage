import type { CoachMarkTour } from '../../lib/api/coach-marks';

/** One coach mark: the copy key (with English until the catalogs merge) and what it points at. */
export interface CoachMarkStep {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /**
   * The element the step is anchored to: a CSS selector, or several tried in order (the first one
   * on the page wins). None on the page: the step is a centred dialog.
   */
  readonly target?: string | readonly string[];
}

/**
 * Row 55-09 — the short first-visit tours (Figma R49 L2, node 592:33601). Three steps each: what
 * the screen is for, the one control that matters most, and where help lives.
 */
export const COACH_MARK_STEPS: Readonly<Record<CoachMarkTour, readonly CoachMarkStep[]>> = {
  my_day: [
    {
      key: 'CoachMarks.myDay.ranked',
      title: 'Your day, ranked',
      body: 'Work that needs you today is at the top. Overdue items come first.',
      target: ['.tm-home-cards', 'section[aria-labelledby="tm-my-day-personal"]'],
    },
    {
      key: 'CoachMarks.myDay.waiting',
      title: 'Waiting on you',
      body: 'Approvals and replies other people need from you collect here.',
      target: 'section[aria-labelledby="tm-my-day-waiting"]',
    },
    {
      // FIX3 item 10: "?" and "Help" are one button now; the step points at the Help menu.
      key: 'CoachMarks.helpMenu',
      title: 'Help is one click away',
      body: 'Press Help beside the screen title for the guide to this screen, or to contact support.',
      target: ['.tm-support-launcher__trigger', '.tm-help-context-link'],
    },
  ],
  projects: [
    {
      key: 'CoachMarks.projects.list',
      title: 'Every project in one place',
      body: 'Each row shows the client, the health and what is due next.',
      target: '.tm-por',
    },
    {
      key: 'CoachMarks.projects.views',
      title: 'Switch the view',
      body: 'Show projects as a list, a board or a timeline. Your choice is remembered.',
      target: '.tm-por-view-bar',
    },
    {
      // FIX3 item 10: "?" and "Help" are one button now; the step points at the Help menu.
      key: 'CoachMarks.helpMenu',
      title: 'Help is one click away',
      body: 'Press Help beside the screen title for the guide to this screen, or to contact support.',
      target: ['.tm-support-launcher__trigger', '.tm-help-context-link'],
    },
  ],
  work_board: [
    {
      key: 'CoachMarks.workBoard.columns',
      title: 'Work moves left to right',
      body: 'Each column is a state. A card is one task.',
      // FIX3 item 4 (T2): anchored to the first column, like the other tours' steps.
      target: ['.tm-wk-board__column', '.tm-wk-board'],
    },
    {
      key: 'CoachMarks.workBoard.move',
      title: 'Move a card to update it',
      body: 'Drag a card, or use its menu, to change its state. Everyone sees it at once.',
      target: ['.tm-wk-card-tile', '.tm-wk-board__column'],
    },
    {
      // FIX3 item 10: "?" and "Help" are one button now; the step points at the Help menu.
      key: 'CoachMarks.helpMenu',
      title: 'Help is one click away',
      body: 'Press Help beside the screen title for the guide to this screen, or to contact support.',
      target: ['.tm-support-launcher__trigger', '.tm-help-context-link'],
    },
  ],
};
