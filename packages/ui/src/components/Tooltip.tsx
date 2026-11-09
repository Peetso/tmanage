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
   * the trigger, so a scrolling rail or a screen edge never clips it.
   */
  placement?: 'top' | 'end';
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
const PLACEMENTS: Record<'top' | 'end', readonly AnchoredSide[]> = {
  top: ['top', 'bottom'],
  end: ['end', 'start', 'bottom', 'top'],
};

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
      setOpen(true);
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
      onMouseEnter={() => {
        cancel();
        if (delayMs <= 0) setOpen(true);
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
