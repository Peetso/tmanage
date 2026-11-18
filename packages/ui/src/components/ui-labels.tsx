import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * The few words the primitives say on their own: the busy button's announcement, the skip link,
 * the live-region landmark, the toast region and its dismiss button, the combobox's empty list.
 *
 * The design system carries no catalog, so each has an English default. An app that renders in
 * another language mounts {@link UiLabelsProvider} once at its root with the translations, and
 * every primitive below it speaks the page's language without each screen passing a label. A
 * label passed as a prop still wins: a screen that needs a more specific word says so.
 */
export interface UiLabels {
  /** What a screen reader says while a `Button` is `loading`. */
  readonly working: string;
  /** The `SkipLink` text. */
  readonly skipToMain: string;
  /** The accessible name of the `LiveAnnouncer` landmark. */
  readonly liveAnnouncements: string;
  /** The accessible name of the `ToastRegion`. */
  readonly notifications: string;
  /** The accessible name of a `Toast`'s dismiss button. */
  readonly dismissNotification: string;
  /** What a `Combobox` says when the filter matches nothing. */
  readonly noMatches: string;
}

export const ENGLISH_UI_LABELS: UiLabels = {
  working: 'Working',
  skipToMain: 'Skip to main content',
  liveAnnouncements: 'Live announcements',
  notifications: 'Notifications',
  dismissNotification: 'Dismiss notification',
  noMatches: 'No matches',
};

const UiLabelsContext = createContext<UiLabels>(ENGLISH_UI_LABELS);

export function UiLabelsProvider({ labels, children }: { labels: UiLabels; children: ReactNode }) {
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>;
}

/** The labels of the nearest {@link UiLabelsProvider}; English outside one. */
export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
