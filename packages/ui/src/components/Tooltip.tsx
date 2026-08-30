import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

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
}

/**
 * The tooltip, built to WCAG 1.4.13's three demands rather than to a hover effect:
 *
 * - **Dismissable** — Escape hides it without moving focus or activating the trigger.
 * - **Hoverable** — the bubble is inside the wrapper the pointer listeners sit on, so
 *   moving the pointer onto the bubble does not close it.
 * - **Persistent** — it stays until hover/focus ends or Escape; nothing times it out.
 *
 * The bubble is in the DOM whether visible or not, and the trigger's `aria-describedby`
 * points at it permanently: a screen reader gets the description from the description
 * mechanism, not from watching visibility change. Keyboard focus shows it because
 * hover-only affordances exclude keyboards.
 */
export function Tooltip({ content, children, defaultOpen = false }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);

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
      setOpen(false);
    },
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    // Pointer and key listeners on a wrapper: the trigger keeps its own handlers, and the
    // hover area includes the bubble itself, which is what "hoverable" means.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      className="tm-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={onKeyDown}
    >
      {trigger}
      <span role="tooltip" id={id} className="tm-tooltip__bubble" data-open={open || undefined}>
        {content}
      </span>
    </span>
  );
}
