'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, useAnchoredPosition } from '@tmanage/ui';
import type { AnchoredSide } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import {
  getCoachMarks,
  rememberTourOutcome,
  rememberedNeverAgain,
  rememberedTourOutcome,
  saveCoachMarks,
  shouldShowTour,
} from '../../lib/api/coach-marks';
import type {
  CoachMarkOutcome,
  CoachMarksPatch,
  CoachMarksView,
  CoachMarkTour as TourId,
} from '../../lib/api/coach-marks';
import { useTOr } from '../../lib/i18n/use-t-or';
import { COACH_MARK_STEPS } from './coach-mark-tours';
import './coach-marks.css';

/** Below the target first, then above, then beside it in reading order. */
const STEP_PLACEMENTS: readonly AnchoredSide[] = ['bottom', 'top', 'end', 'start'];
/** Room kept around the target inside the spotlight cut-out, in px. */
const SPOTLIGHT_PAD = 6;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function findTarget(selector: string | readonly string[] | undefined): HTMLElement | null {
  if (selector === undefined || typeof document === 'undefined') return null;
  const selectors: readonly string[] = typeof selector === 'string' ? [selector] : selector;
  for (const one of selectors) {
    const element = document.querySelector<HTMLElement>(one);
    if (element !== null) return element;
  }
  return null;
}

function isOffScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const height = document.documentElement.clientHeight || window.innerHeight;
  const width = document.documentElement.clientWidth || window.innerWidth;
  return rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width;
}

/**
 * Whether `node` sits in another modal dialog than the tour's `card` — one the person opened over
 * the tour (the command palette). That modal owns focus and its keys; the tour does not take them.
 */
function inOtherModal(node: EventTarget | null, card: HTMLElement | null): boolean {
  return (
    node instanceof Element &&
    card !== null &&
    !card.contains(node) &&
    node.closest('[aria-modal="true"]') !== null
  );
}

/**
 * Row 55-09 — a short first-visit tour (Figma R49 L2, node 592:33601): "n of 3", Back / Next,
 * "Skip tour" and "Don't show tours again". It opens only when the member has never finished or
 * skipped this tour and has not turned tours off; the outcome is kept in their own preferences, so
 * it never shows twice on any device.
 *
 * Each step is anchored to the element it describes (Peter, 2026-11-09: never a corner card): the
 * target is scrolled into view, the rest of the page is dimmed with a cut-out around it and a lime
 * ring, and the step card sits next to it with an arrow, flipping and shifting to stay on screen
 * (start/end follow the reading direction, so Arabic mirrors). A step whose target is not on the
 * page shows as a centred dialog. While open the step is a modal dialog: focus moves into it and
 * stays there, Escape and "Skip tour" close it, and focus returns where it was.
 */
export function CoachMarkTour({
  organizationSlug,
  tour,
  client,
}: {
  readonly organizationSlug: string;
  readonly tour: TourId;
  readonly client?: ApiClient;
}) {
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const key = ['coach-marks', organizationSlug] as const;
  const state = useQuery({ queryKey: key, queryFn: () => getCoachMarks(api, organizationSlug) });
  const save = useMutation({
    mutationFn: (patch: CoachMarksPatch) => saveCoachMarks(api, organizationSlug, patch),
    onSuccess: (view) => queryClient.setQueryData(key, view),
    // A save lost on a bad connection is tried again; the device copy covers the meantime.
    retry: 2,
  });
  // FIX3 item 4 (T1): how this tour ended on this device. A tour that ended here never opens
  // again here, whatever an older or failed server answer says.
  const [ended, setEnded] = useState<CoachMarkOutcome | null>(() =>
    rememberedTourOutcome(organizationSlug, tour),
  );
  const [offHere] = useState(() => rememberedNeverAgain(organizationSlug));
  const resent = useRef(false);
  const [step, setStep] = useState(0);
  const [neverAgain, setNeverAgain] = useState(false);
  const [closed, setClosed] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const primary = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const steps = COACH_MARK_STEPS[tour];
  const open = !closed && ended === null && !offHere && shouldShowTour(state.data, tour);
  // FIX3 item 4 (T2): a step whose target is not drawn yet (the board still loading) is anchored
  // as soon as it appears, instead of staying a centred dialog.
  const [drawn, setDrawn] = useState(0);
  const current = steps[step];

  // Find the step's target before paint, so the card never flashes in a default spot.
  useLayoutEffect(() => {
    if (!open) {
      setTarget(null);
      return undefined;
    }
    const element = findTarget(current?.target);
    setTarget(element);
    if (element === null) return undefined;
    element.setAttribute('data-coach-active', '');
    if (isOffScreen(element)) element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    return () => element.removeAttribute('data-coach-active');
  }, [open, current, drawn]);

  useEffect(() => {
    const selector = current?.target;
    if (!open || target !== null || selector === undefined) return undefined;
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (findTarget(selector) === null) return;
      observer.disconnect();
      setDrawn((count) => count + 1);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, target, current]);

  // The server still says "not seen" for a tour that ended on this device: the save did not land,
  // so it is sent once more.
  useEffect(() => {
    if (ended === null || resent.current || state.data === undefined) return;
    if (!shouldShowTour(state.data, tour)) return;
    resent.current = true;
    save.mutate({ tour, outcome: ended });
  }, [ended, state.data, tour, save]);

  const position = useAnchoredPosition(target, card, open && target !== null, {
    placements: STEP_PLACEMENTS,
    offset: 14,
    padding: 16,
    arrowPadding: 20,
  });

  const finish = (outcome: CoachMarkOutcome) => {
    setClosed(true);
    setEnded(outcome);
    resent.current = true;
    rememberTourOutcome(organizationSlug, tour, outcome, neverAgain);
    // Every screen's tour reads this cache: mark the tour ended now, and drop a read still on its
    // way, so no screen opens it again before the save answers.
    void queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<CoachMarksView>(key, (view) =>
      view === undefined
        ? view
        : {
            tours: { ...view.tours, [tour]: outcome },
            neverAgain: view.neverAgain || neverAgain,
          },
    );
    save.mutate(neverAgain ? { tour, outcome, neverAgain: true } : { tour, outcome });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Focus moves into the dialog when it opens (and onto the step's main action each step), and
  // returns to where it was when the tour closes.
  useEffect(() => {
    if (!open) return undefined;
    if (returnFocus.current === null && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
    return undefined;
  }, [open]);
  // Wait until an anchored card is placed: it is not drawn before then and cannot take focus.
  const placed = target === null || position !== null;
  useEffect(() => {
    if (!open || card === null || !placed) return;
    if (inOtherModal(document.activeElement, card)) return;
    const action = primary.current?.querySelector<HTMLElement>('button');
    (action ?? card).focus({ preventScroll: true });
  }, [open, card, step, placed]);
  useEffect(() => {
    if (open) return;
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
  }, [open]);

  // Escape skips the tour wherever focus is; Tab and Shift+Tab cycle inside the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (inOtherModal(document.activeElement, card)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finishRef.current('skipped');
        return;
      }
      if (event.key !== 'Tab' || card === null) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const final = items[items.length - 1];
      if (first === undefined || final === undefined) return;
      const active = document.activeElement;
      if (!card.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        final.focus();
      } else if (!event.shiftKey && active === final) {
        event.preventDefault();
        first.focus();
      }
    };
    // Focus that lands outside (the screen's own focus management on load) is brought back.
    const onFocusIn = (event: FocusEvent) => {
      if (card === null || !(event.target instanceof Node) || card.contains(event.target)) return;
      if (inOtherModal(event.target, card)) return;
      const action = primary.current?.querySelector<HTMLElement>('button');
      (action ?? card).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, card]);

  if (!open || current === undefined) return null;

  const last = step === steps.length - 1;
  const anchored = target !== null;

  const cardStyle: CSSProperties | undefined =
    anchored && position !== null
      ? { top: `${position.y}px`, left: `${position.x}px`, right: 'auto', bottom: 'auto' }
      : undefined;
  const vertical = position?.physicalSide === 'top' || position?.physicalSide === 'bottom';
  const arrowStyle: CSSProperties | undefined =
    position === null
      ? undefined
      : vertical
        ? { left: `${position.arrow}px` }
        : { top: `${position.arrow}px` };
  const spotlightStyle: CSSProperties | undefined =
    position === null
      ? undefined
      : {
          top: `${position.anchor.top - SPOTLIGHT_PAD}px`,
          left: `${position.anchor.left - SPOTLIGHT_PAD}px`,
          width: `${position.anchor.width + SPOTLIGHT_PAD * 2}px`,
          height: `${position.anchor.height + SPOTLIGHT_PAD * 2}px`,
        };

  return (
    <div className="tm-coach-layer" data-anchored={anchored || undefined}>
      {/* Blocks the page while the step is open; dims it when there is no target to cut out. */}
      <div className="tm-coach-scrim" aria-hidden="true" />
      {anchored && spotlightStyle !== undefined ? (
        <div className="tm-coach-spotlight" aria-hidden="true" style={spotlightStyle} />
      ) : null}
      <section
        ref={setCard}
        className={anchored ? 'tm-coach' : 'tm-coach tm-coach--center'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-side={anchored ? position?.physicalSide : undefined}
        data-placed={!anchored || position !== null || undefined}
        style={cardStyle}
      >
        {anchored && position !== null && position.fits ? (
          <span className="tm-coach__arrow" aria-hidden="true" style={arrowStyle} />
        ) : null}
        <p className="tm-coach__step">
          {tOr('CoachMarks.stepOf', '{n} of {total}')
            .replace('{n}', String(step + 1))
            .replace('{total}', String(steps.length))}
        </p>
        <h2 id={titleId} className="tm-coach__title">
          {tOr(`${current.key}.title`, current.title)}
        </h2>
        <p id={bodyId} className="tm-coach__body">
          {tOr(`${current.key}.body`, current.body)}
        </p>
        <label className="tm-coach__never">
          <input
            type="checkbox"
            checked={neverAgain}
            onChange={(event) => setNeverAgain(event.target.checked)}
          />
          {tOr('CoachMarks.neverAgain', 'Don’t show tours again')}
        </label>
        <div className="tm-coach__actions">
          <button type="button" className="tm-coach__skip" onClick={() => finish('skipped')}>
            {tOr('CoachMarks.skip', 'Skip tour')}
          </button>
          <span className="tm-coach__spacer" />
          {step > 0 ? (
            <Button tone="outline" onClick={() => setStep(step - 1)}>
              {tOr('CoachMarks.back', 'Back')}
            </Button>
          ) : null}
          <div ref={primary} className="tm-coach__primary">
            <Button tone="lime" onClick={() => (last ? finish('done') : setStep(step + 1))}>
              {last ? tOr('CoachMarks.done', 'Done') : tOr('CoachMarks.next', 'Next')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
