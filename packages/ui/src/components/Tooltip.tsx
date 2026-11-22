import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { useAnchoredPosition, type AnchoredSide } from './anchored-position.js';

export interface TooltipProps {
  /** The supplementary sentence. Text only — a tooltip that needs structure is a popover. */
  content: string;
  /**
   * The trigger. It must already be focusable and already have an accessible name of its
   * own: a tooltip *describes*, it never names. An icon-only control therefore keeps its
   * `aria-label`, and the tooltip adds the longer sentence beside it.
   */
  children: ReactElement<{
    'aria-describedby'?: string;
    onFocus?: (event: unknown) => void;
    onBlur?: (event: unknown) => void;
  }>;
  /**
   * Renders the bubble open with no interaction. For the visual harness, which cannot
   * hover, and for nothing else — an always-open tooltip on a real screen is a caption.
   */
  defaultOpen?: boolean;
  /**
   * Hover intent: the pointer must rest this long before the bubble shows (FIX2 hover help uses
   * about 600 ms, so passing over a row of icons does not flash a bubble per icon). Keyboard
   * focus always shows it at once. 0 (the default) opens on hover immediately.
   */
  delayMs?: number;
  /** Extra class on the wrapper (`tm-tooltip--block` for a full-width trigger). */
  className?: string;
  /**
   * Where the bubble prefers to show. `'top'` (the default) sits above the trigger and flips below
   * it when there is no room; `'end'` sits beside it (after it in reading order, so on the left in
   * Arabic) and flips to the other side, then above or below. Either way the bubble is placed in
   * the viewport (`position: fixed`), shifts so it never leaves the screen, and its arrow points at
   * the trigger, so a scrolling rail or a screen edge never clips it. `'bottom'` sits below the
   * trigger and flips above it (a number tile whose label sits under the value).
   */
  placement?: 'top' | 'end' | 'bottom';
}

/**
 * The tooltip, built to WCAG 1.4.13's three demands rather than to a hover effect:
 *
 * - **Dismissable** — Escape hides it without moving focus or activating the trigger,
 *   and it works for a *hover-only* opening too: a mouse user's focus is elsewhere, so
 *   while the bubble is open the Escape listener sits on the document, not the wrapper.
 * - **Hoverable** — the bubble is inside the wrapper the pointer listeners sit on, so
 *   moving the pointer onto the bubble does not close it.
 * - **Persistent** — it stays until hover/focus ends or Escape; nothing times it out.
 *
 * The bubble is in the DOM whether visible or not, and the trigger's `aria-describedby`
 * points at it permanently: a screen reader gets the description from the description
 * mechanism, not from watching visibility change. Keyboard focus shows it because
 * hover-only affordances exclude keyboards.
 */
const PLACEMENTS: Record<'top' | 'end' | 'bottom', readonly AnchoredSide[]> = {
  top: ['top', 'bottom'],
  end: ['end', 'start', 'bottom', 'top'],
  bottom: ['bottom', 'top'],
};

/**
 * `motion.delay.tooltip`: how long the pointer rests before a tooltip shows (My Day v3 spec §4).
 * No published source gives a figure (NN/g gives none, the WAI-ARIA APG says "a small delay"), so
 * 700 ms is a TManage target, kept in this one place so the persona test can tune it. It is not in
 * the design export's `motion` scale (`tokens.json`, pinned by `tokens.drift.test.ts`), which is
 * why it lives here and not in `tokens.ts`.
 */
export const MOTION_DELAY_TOOLTIP_MS = 700;

/** After a tooltip closes, a neighbour reached within this window shows at once (spec §4 (b)). */
const WARM_WINDOW_MS = 400;
/** A mouse event this soon after a touch is the browser's emulation of the tap, not a hover. */
const TOUCH_EMULATION_MS = 1000;

/**
 * Shared by every tooltip on the page: how many are open, until when the group stays "warm", and
 * when the last touch happened. Module state on purpose: the warm-up belongs to the pointer, not
 * to one trigger.
 */
const group = { open: 0, warmUntil: 0, touchedAt: Number.NEGATIVE_INFINITY };

function warm(now: number): boolean {
  return group.open > 0 || now < group.warmUntil;
}

function touchedRecently(now: number): boolean {
  return now - group.touchedAt < TOUCH_EMULATION_MS;
}

export function Tooltip({
  content,
  children,
  defaultOpen = false,
  delayMs = 0,
  className,
  placement = 'top',
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [wrapper, setWrapper] = useState<HTMLSpanElement | null>(null);
  const [bubble, setBubble] = useState<HTMLSpanElement | null>(null);
  const position = useAnchoredPosition(wrapper, bubble, open, {
    placements: PLACEMENTS[placement],
    offset: 8,
  });
  const bubbleStyle: CSSProperties | undefined = position
    ? {
        position: 'fixed',
        top: `${position.y}px`,
        left: `${position.x}px`,
        right: 'auto',
        bottom: 'auto',
      }
    : undefined;
  const vertical = position?.physicalSide === 'top' || position?.physicalSide === 'bottom';
  const arrowStyle: CSSProperties | undefined = position
    ? vertical
      ? { left: `${position.arrow}px` }
      : { top: `${position.arrow}px` }
    : undefined;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => cancel, []);

  // The warm-up group (spec §4 (b)): count the open tooltips, and keep the group warm a moment
  // after the last one closes so the next one the pointer reaches shows at once.
  useEffect(() => {
    if (!open) return undefined;
    group.open += 1;
    return () => {
      group.open -= 1;
      group.warmUntil = Date.now() + WARM_WINDOW_MS;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!isValidElement(children)) {
    throw new Error('Tooltip needs a single element child to describe.');
  }

  const child = children;
  const existingDescribedBy = child.props['aria-describedby'];

  const trigger = cloneElement(child, {
    'aria-describedby': [existingDescribedBy, id].filter(Boolean).join(' '),
    onFocus: (event: unknown) => {
      child.props.onFocus?.(event);
      // A tap focuses the control too; on touch there is no tooltip (the info sheet is the place).
      if (!touchedRecently(Date.now())) setOpen(true);
    },
    onBlur: (event: unknown) => {
      child.props.onBlur?.(event);
      cancel();
      setOpen(false);
    },
  });

  return (
    // Pointer listeners on a wrapper: the trigger keeps its own handlers, and the hover
    // area includes the bubble itself, which is what "hoverable" means.
    <span
      ref={setWrapper}
      className={className ? `tm-tooltip ${className}` : 'tm-tooltip'}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch') group.touchedAt = Date.now();
      }}
      onTouchStart={() => {
        group.touchedAt = Date.now();
      }}
      onMouseEnter={() => {
        cancel();
        const now = Date.now();
        if (touchedRecently(now)) return;
        if (delayMs <= 0 || warm(now)) setOpen(true);
        else timer.current = setTimeout(() => setOpen(true), delayMs);
      }}
      onMouseLeave={() => {
        cancel();
        setOpen(false);
      }}
    >
      {trigger}
      <span
        ref={setBubble}
        role="tooltip"
        id={id}
        className="tm-tooltip__bubble"
        data-open={open || undefined}
        data-side={position?.physicalSide}
        {...(bubbleStyle ? { style: bubbleStyle } : {})}
      >
        {content}
        {position ? (
          <span className="tm-tooltip__arrow" aria-hidden="true" style={arrowStyle} />
        ) : null}
      </span>
    </span>
  );
}
