'use client';

import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { IconButton } from '@tmanage/ui';
import { useDismiss } from '../use-dismiss';

/**
 * Figma `Panel/Row` (`918:1957`): one 32 px line of the work's properties panel — a muted label in
 * the 104 px label column, the value, and a 28 px trailing slot on the end edge that holds the
 * row's one icon action (plus, chevron, info, play, forward) or stays empty so every value and
 * icon line up (Fable must-fix 2). The value and the icon open the same editor in place, a
 * popover under the row (`popover`), or run `onAction` when the row has no popover.
 *
 * Nothing opens a second form: this row is the only place the property is edited on the page
 * (WORK-AREA plan §4.3).
 */
export interface PanelRowProps {
  readonly label: string;
  /** The value as drawn; "Add" (muted) when empty. */
  readonly value: ReactNode;
  readonly empty?: boolean;
  /** The trailing icon and its accessible name; absent = the empty slot. */
  readonly icon?: ReactNode;
  readonly iconLabel?: string;
  /** The in-place editor, opened by the value or the icon. */
  readonly popover?: (close: () => void) => ReactNode;
  /** Instead of a popover: what the value and the icon do (open a picker). */
  readonly onAction?: () => void;
  /** Instead of a popover: the page the value and the icon open (time logs, links). */
  readonly href?: string;
  /** A row that only shows (the reader may not edit it). */
  readonly readOnly?: boolean;
  readonly testId?: string;
}

export function PanelRow({
  label,
  value,
  empty = false,
  icon,
  iconLabel,
  popover,
  onAction,
  href,
  readOnly = false,
  testId,
}: PanelRowProps) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const popoverId = useId();
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const interactive = !readOnly && (popover !== undefined || onAction !== undefined);

  function activate() {
    if (popover) setOpen((now) => !now);
    else onAction?.();
  }
  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  // Escape closes and returns focus; a press outside the row closes without a change.
  useDismiss(open, row, (reason) => close(reason === 'escape'));

  return (
    <div ref={row} className="tm-wk-prow" data-open={open || undefined} data-testid={testId}>
      <span id={labelId} className="tm-wk-prow__label">
        {label}
      </span>
      {href !== undefined && !readOnly ? (
        <Link className="tm-wk-prow__value" href={href} data-empty={empty || undefined}>
          <span className="tm-wk-prow__text">{value}</span>
        </Link>
      ) : interactive ? (
        <button
          ref={trigger}
          type="button"
          className="tm-wk-prow__value"
          data-empty={empty || undefined}
          aria-labelledby={`${labelId} ${popoverId}-v`}
          aria-haspopup={popover ? 'dialog' : undefined}
          aria-expanded={popover ? open : undefined}
          onClick={activate}
        >
          <span id={`${popoverId}-v`} className="tm-wk-prow__text">
            {value}
          </span>
        </button>
      ) : (
        <span className="tm-wk-prow__value" data-empty={empty || undefined}>
          <span className="tm-wk-prow__text">{value}</span>
        </span>
      )}
      <span className="tm-wk-prow__slot">
        {href !== undefined && !readOnly && icon && iconLabel ? (
          <Link
            className="tm-icon-button tm-icon-button--small"
            href={href}
            aria-label={iconLabel}
            tabIndex={-1}
          >
            <span className="tm-icon-button__glyph" aria-hidden="true">
              {icon}
            </span>
          </Link>
        ) : interactive && icon && iconLabel ? (
          <IconButton
            size="small"
            label={iconLabel}
            icon={icon}
            aria-expanded={popover ? open : undefined}
            onClick={activate}
          />
        ) : null}
      </span>
      {open && popover ? (
        <div id={popoverId} className="tm-wk-popover" role="dialog" aria-labelledby={labelId}>
          {popover(() => close())}
        </div>
      ) : null}
    </div>
  );
}
