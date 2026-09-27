/**
 * The words every platform state says, in one pure map.
 *
 * `38-MODULE-MAP` §Platform states names a standard matrix — 403, 404, 500, empty and
 * loading — that the audit found only partly built: individual screens improvised their own
 * "nothing here" and "something went wrong" copy, so the same situation read differently on
 * each page. This map is the single source of that copy, so a person meets the same words for
 * the same state wherever they hit it, and a test can assert the string the component renders
 * rather than a second copy of it.
 *
 * It is deliberately free of React. Copy is data — a title, a description, and the label of
 * the primary action where the state has one — so it can be unit-tested on its own and reused
 * by anything that needs the same sentence (a route page, an inline empty region, a future
 * portal state) without importing a component.
 *
 * ## What the copy may and may not say
 *
 * The forbidden and not-found states point a stuck person at the one next step this
 * application can honestly offer — the workspace administrator — in the exact words
 * `RecoveryScreen` already uses for a locked-out person. Nothing here invents a support
 * address, a phone number or a promised turnaround, because a friendly sentence that names a
 * channel the product does not have is the same defect in a nicer voice.
 */

/** The five states in the standard matrix. */
export type StateKey = 'forbidden' | 'notFound' | 'serverError' | 'empty' | 'loading';

export interface StateCopy {
  /** The one line a person reads first — the `<h1>` of the state. */
  readonly title: string;
  /** The supporting sentence beneath it, in the reader's terms. */
  readonly description: string;
  /**
   * The label of the primary action, where the state has one.
   *
   * `empty` and `loading` have none: an empty region's call to action belongs to the screen
   * that knows what is missing, and a loading region is a wait, not a choice. Their absence
   * here is the map saying so, not an oversight.
   */
  readonly action?: string;
}

export const STATE_COPY: Record<StateKey, StateCopy> = {
  forbidden: {
    title: 'You don’t have access to this',
    description:
      'You’re signed in, but this account isn’t allowed to open this page. If you think you should be, ask whoever administers your TManage workspace to grant you access.',
    action: 'Back to home',
  },
  notFound: {
    title: 'We couldn’t find that page',
    description:
      'The page you asked for doesn’t exist, or the link that brought you here is out of date. Check the address, or head back and try again.',
    action: 'Back to home',
  },
  serverError: {
    title: 'Something went wrong on our end',
    description:
      'This page couldn’t load because of an error here, not anything you did. Trying again often clears it; if it keeps happening, ask whoever administers your TManage workspace.',
    action: 'Try again',
  },
  empty: {
    title: 'Nothing here yet',
    description:
      'There’s nothing to show on this page yet. When something is added, it appears here.',
  },
  loading: {
    title: 'Loading',
    description: 'One moment while this page loads.',
  },
};
