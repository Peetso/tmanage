'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useUiLabels } from './ui-labels.js';

/**
 * The announcement plumbing for status messages — WCAG 2.2 **4.1.3**.
 *
 * ## Why this exists rather than an `aria-live` div per loading state
 *
 * A screen that draws `<div aria-live="polite"><span>Loading…</span></div>` only while a
 * query is pending inserts the live region *together with* its first text. Assistive
 * technology registers a live region when it enters the document and then announces later
 * *mutations*; a region that arrives already populated is routinely not announced at all.
 * `Combobox.tsx` learned this and keeps its empty-state region mounted from the start — this
 * carries the same rule to every screen, so it is impossible to reintroduce the defect one
 * screen at a time.
 *
 * The region is mounted **empty** by a shell and never unmounts. `useAnnounce()` writes into
 * it from an effect (after the commit that mounted the writer), so the region is committed
 * empty first and the text lands as a mutation — the shape assistive technology announces.
 *
 * Two slots per politeness are written alternately, so repeating the same sentence — "Loading
 * more", pressed twice — still changes the DOM and is still announced rather than swallowed as
 * an identical text node.
 */
export type AnnouncePoliteness = 'polite' | 'assertive';

export type AnnounceFn = (message: string, politeness?: AnnouncePoliteness) => void;

const noop: AnnounceFn = () => {};

const LiveAnnouncerContext = createContext<AnnounceFn | null>(null);

/** Clears `message` from whichever slot still holds it; a no-op when no slot does. */
type RetractFn = (message: string) => void;

const noopRetract: RetractFn = () => {};

const LiveAnnouncerRetractContext = createContext<RetractFn | null>(null);

/**
 * The announce function for the nearest `LiveAnnouncer`. Outside one it is a safe no-op, so a
 * component that announces can still be rendered bare in a test without a provider.
 */
export function useAnnounce(): AnnounceFn {
  return useContext(LiveAnnouncerContext) ?? noop;
}

export interface LiveAnnouncerProps {
  children: ReactNode;
  /**
   * The accessible name of the announcer's landmark. English by default; an app that renders in
   * another language passes its own translation so the landmark is named in the page's language.
   */
  label?: string;
}

export function LiveAnnouncer({ children, label: passedLabel }: LiveAnnouncerProps) {
  const labels = useUiLabels();
  const label = passedLabel ?? labels.liveAnnouncements;
  const [polite, setPolite] = useState<readonly [string, string]>(['', '']);
  const [assertive, setAssertive] = useState<readonly [string, string]>(['', '']);
  const politeSlot = useRef(0);
  const assertiveSlot = useRef(0);

  const announce = useCallback<AnnounceFn>((message, politeness = 'polite') => {
    if (message === '') return;
    if (politeness === 'assertive') {
      const slot = assertiveSlot.current;
      assertiveSlot.current = slot === 0 ? 1 : 0;
      setAssertive(slot === 0 ? [message, ''] : ['', message]);
    } else {
      const slot = politeSlot.current;
      politeSlot.current = slot === 0 ? 1 : 0;
      setPolite(slot === 0 ? [message, ''] : ['', message]);
    }
  }, []);

  // Emptying a slot is a removal, which a polite/assertive region does not read aloud (the default
  // `aria-relevant` is additions + text) — it only stops a stale sentence from lingering in the
  // region after the state it described is gone.
  const retract = useCallback<RetractFn>((message) => {
    if (message === '') return;
    const clear = (slots: readonly [string, string]) =>
      slots[0] === message || slots[1] === message
        ? ([slots[0] === message ? '' : slots[0], slots[1] === message ? '' : slots[1]] as const)
        : slots;
    setPolite(clear);
    setAssertive(clear);
  }, []);

  return (
    <LiveAnnouncerContext.Provider value={announce}>
      <LiveAnnouncerRetractContext.Provider value={retract}>
        {children}
        {/*
         * The live-region semantics are carried by `aria-live` + `aria-atomic`, not by
         * `role="status"`/`role="alert"`. A screen reader announces a mutation of an `aria-live`
         * region regardless of its role, so announcements are unaffected — and the always-mounted,
         * usually-empty slots do not register as extra `status`/`alert` roles, which would
         * otherwise turn every screen's single real alert into "multiple elements with the role".
         */}
        {/*
         * The slots render after `{children}` — outside `<main>` and every other landmark. axe's
         * `region` rule (a best-practice rule the web axe helper leaves on) flags perceivable
         * content that sits in no landmark, and a slot holding an announcement is exactly that. A
         * named `role="region"` wrapper makes the whole announcer a landmark, so a scan taken while
         * a sentence is live cannot fail `region`. (Each slot already carries `aria-live`, which axe
         * treats as region-satisfying on its own, so this is belt-and-braces — but it keeps the
         * guarantee from depending on that internal axe behaviour.)
         */}
        <div className="tm-visually-hidden" role="region" aria-label={label}>
          <div aria-live="polite" aria-atomic="true">
            {polite[0]}
          </div>
          <div aria-live="polite" aria-atomic="true">
            {polite[1]}
          </div>
          <div aria-live="assertive" aria-atomic="true">
            {assertive[0]}
          </div>
          <div aria-live="assertive" aria-atomic="true">
            {assertive[1]}
          </div>
        </div>
      </LiveAnnouncerRetractContext.Provider>
    </LiveAnnouncerContext.Provider>
  );
}

export interface LoadingRegionProps {
  /** The sentence a screen reader hears when this loading state appears, e.g. "Loading the inbox." */
  label: string;
  /** Optional class on the placeholder wrapper, so a caller keeps the layout its old markup had. */
  className?: string;
  /** The visual placeholder — usually skeletons. Presentation only; the announcement is `label`. */
  children?: ReactNode;
}

/**
 * A loading placeholder that announces itself into the ambient `LiveAnnouncer`.
 *
 * Mounting this while a query is pending draws `children` (skeletons) and, from an effect,
 * writes `label` into the shell's always-mounted region — so the sentence is a mutation of a
 * region that already existed, not a region that arrived pre-filled. Replaces the
 * `<div aria-busy aria-live>…</div>` blocks that mounted their region with their content.
 *
 * The wrapper carries `aria-busy` but **not** `aria-live`: the announcement is the shell's job,
 * so this element never doubles as a live region that would announce its own skeletons.
 *
 * The sentence belongs to the loading state, so it leaves with it: when `label` changes (the
 * locale switched mid-load) the old sentence is cleared before the new one is written, and on
 * unmount the slot is emptied — the region never keeps saying "Loading…" after the content
 * arrived, nor keeps it in the language that was active when loading began.
 */
export function LoadingRegion({ label, className, children }: LoadingRegionProps) {
  const announce = useAnnounce();
  const retract = useContext(LiveAnnouncerRetractContext) ?? noopRetract;
  useEffect(() => {
    announce(label);
    return () => retract(label);
  }, [announce, retract, label]);
  return (
    <div aria-busy="true" data-loading="true" className={className}>
      {children}
    </div>
  );
}

export interface AnnounceProps {
  /** The sentence to announce. Announcing changes on each new value; an empty string is ignored. */
  message: string;
  politeness?: AnnouncePoliteness;
}

/**
 * A render-nothing announcer for a status that is not a loading placeholder — "12 more loaded,
 * 48 in total" after a "Load more", say. It writes `message` into the ambient `LiveAnnouncer`
 * from an effect, so the text lands as a mutation of the shell's always-mounted region (WCAG
 * 2.2 **4.1.3**) rather than into a region mounted alongside its own first content. Rendered
 * inside a shell, so `useAnnounce()` resolves to the real region rather than the no-op.
 */
export function Announce({ message, politeness }: AnnounceProps) {
  const announce = useAnnounce();
  useEffect(() => {
    announce(message, politeness);
  }, [announce, message, politeness]);
  return null;
}
