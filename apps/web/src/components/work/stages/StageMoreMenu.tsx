'use client';

import { useId, useRef, useState } from 'react';
import { IconButton } from '@tmanage/ui';
import { useDismiss } from '../use-dismiss';
import { MoreIcon } from '../work-icons';

export interface StageMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  /** Why the entry cannot be used now; it is drawn off with this line under it. */
  readonly blockedBy?: string | undefined;
  readonly disabled?: boolean;
}

/**
 * The ⋯ of a stage row and of a stage set (Figma W7, `Header/Button Icon Small` 28 × 28): a menu
 * button (WAI-ARIA APG "Menu Button"). Arrow keys move between the entries, Escape and a press
 * outside close it and give focus back to the ⋯. An entry the set rules forbid stays in the menu,
 * drawn off, with its reason, so nobody wonders where Delete went (UX-3 constraints).
 */
export function StageMoreMenu({
  label,
  entries,
}: {
  /** The button's accessible name ("More for Ideate"). */
  label: string;
  entries: readonly StageMenuEntry[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) box.current?.querySelector<HTMLButtonElement>('.tm-stg-more__button')?.focus();
  };
  useDismiss(open, box, (reason) => close(reason === 'escape'));

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  return (
    <span ref={box} className="tm-stg-more">
      <IconButton
        className="tm-stg-more__button"
        size="small"
        label={label}
        icon={<MoreIcon />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen(!open);
          if (!open)
            requestAnimationFrame(() =>
              items()
                .find((item) => !item.disabled)
                ?.focus(),
            );
        }}
      />
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className="tm-wk-menu tm-stg-more__menu"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const list = items().filter((item) => !item.disabled);
            const at = list.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
            next?.focus();
          }}
        >
          {entries.map((entry) => (
            <span key={entry.id} className="tm-stg-more__entry">
              <button
                type="button"
                role="menuitem"
                className="tm-wk-menu__item"
                data-tone={entry.danger ? 'danger' : undefined}
                disabled={entry.disabled === true || entry.blockedBy !== undefined}
                onClick={() => {
                  close(false);
                  entry.onSelect();
                }}
              >
                {entry.label}
              </button>
              {entry.blockedBy ? <span className="tm-stg-more__why">{entry.blockedBy}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </span>
  );
}
