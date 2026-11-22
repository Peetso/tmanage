import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useAnchoredPosition } from './anchored-position.js';

/**
 * The one "open an explanation" event on the page. Opening an info popover announces its id;
 * every other one closes, so only one is open at a time (My Day v3 spec §4 (a)).
 */
const INFO_OPEN_EVENT = 'tm-info-popover-open';

export interface InfoPopoverProps {
  /** The DOM id the trigger's `aria-controls` names. */
  id: string;
  /** Bold first line: the name of what is explained. */
  title: string;
  /** At most two sentences (spec §5). Plain text; no links, no controls. */
  children: ReactNode;
  /** Whether the surface is drawn. It stays in the DOM either way, so `aria-controls` resolves. */
  open: boolean;
  /** The element the popover is anchored to (the info button). */
  anchor: HTMLElement | null;
}

/**
 * **InfoPopover**, the surface the circled "i" opens: 280 wide, raised surface, high elevation,
 * the title in bold and the text under it. Anchored under the trigger at the start edge and
 * flipped above it when there is no room (`useAnchoredPosition`). It does not trap focus and does
 * not dim the page: it is a disclosure, not a dialog (WAI-ARIA APG, Disclosure pattern).
 */
export function InfoPopover({ id, title, children, open, anchor }: InfoPopoverProps) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const position = useAnchoredPosition(anchor, surface, open, {
    placements: ['bottom', 'top'],
    offset: 8,
  });
  const style: CSSProperties | undefined = position
    ? { position: 'fixed', top: `${position.y}px`, left: `${position.x}px` }
    : undefined;
  return (
    <div
      ref={setSurface}
      id={id}
      className="tm-info-popover"
      data-open={open || undefined}
      hidden={!open}
      {...(style ? { style } : {})}
    >
      <p className="tm-info-popover__title">{title}</p>
      <p className="tm-info-popover__body">{children}</p>
    </div>
  );
}

export interface InfoButtonProps {
  /** What the button explains, e.g. "Due & at risk". The accessible name is `label`. */
  title: string;
  /** The accessible name, already translated: "About Due & at risk" / «حول المطلوب والمتأخر». */
  label: string;
  /** The info text, at most two sentences. */
  children: ReactNode;
  className?: string;
  /** For the visual harness only: render with the popover open. */
  defaultOpen?: boolean;
}

/**
 * **InfoButton**: the circled "i" placed directly after the title it explains (My Day v3 spec
 * §4 (a), Figma component `Info button` 810:24). One glyph for every explanation in the app: "?"
 * stays for the Help centre and "!" for warnings (VIS-12).
 *
 * - A real `<button>` with `aria-expanded` and `aria-controls` (APG Disclosure). 16 px glyph in a
 *   24 × 24 target (WCAG 2.5.8 AA).
 * - Opens on click, Enter or Space (native button activation), never on hover.
 * - Closes on Escape (focus returns to the button), a click outside, a second click, or another
 *   info button opening. Only one is open at a time.
 * - Never holds an error, a blocking limit or what an irreversible action does: those stay on the
 *   screen when they matter.
 */
export function InfoButton({
  title,
  label,
  children,
  className,
  defaultOpen = false,
}: InfoButtonProps) {
  const id = useId();
  const popoverId = `${id}-info`;
  const [open, setOpen] = useState(defaultOpen);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  useInfoDismissal(open, setOpen, popoverId, wrapper, button);

  return (
    <span ref={wrapper} className={['tm-info', className].filter(Boolean).join(' ')}>
      <button
        ref={setButton}
        type="button"
        className="tm-info-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => {
          const next = !open;
          if (next) window.dispatchEvent(new CustomEvent(INFO_OPEN_EVENT, { detail: popoverId }));
          setOpen(next);
        }}
      >
        <InfoGlyph />
      </button>
      <InfoPopover id={popoverId} title={title} open={open} anchor={button}>
        {children}
      </InfoPopover>
    </span>
  );
}

/** Escape, a click outside, and another info button opening each close this one. */
function useInfoDismissal(
  open: boolean,
  setOpen: (open: boolean) => void,
  popoverId: string,
  wrapper: RefObject<HTMLSpanElement | null>,
  button: HTMLButtonElement | null,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapper.current && !wrapper.current.contains(target)) {
        setOpen(false);
      }
    };
    const onOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== popoverId) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener(INFO_OPEN_EVENT, onOther);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener(INFO_OPEN_EVENT, onOther);
    };
  }, [open, setOpen, popoverId, wrapper, button]);
}

/** Figma `Icon/Info`: a 12 px ring, a dot and a stem, in the current text colour. */
function InfoGlyph() {
  return (
    <svg
      className="tm-info-button__glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" />
      <rect x="7.2" y="7" width="1.6" height="5" fill="currentColor" />
      <circle cx="8" cy="5" r="1" fill="currentColor" />
    </svg>
  );
}
