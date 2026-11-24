'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { DotsIcon } from './ai-icons';

export interface RowMenuItem {
  readonly key: string;
  readonly label: string;
  /** A link item (View profile, Remove → offboarding). */
  readonly href?: string;
  readonly onSelect?: () => void;
  /** Retire, Remove: the danger colour, after a divider. */
  readonly danger?: boolean;
  readonly icon?: ReactNode;
}

/**
 * The ⋯ menu of a People row and of the AI profile header (S1, S6e0): an APG menu button. The
 * first item takes the focus on open; Escape or a press outside closes it and focus goes back to
 * the button. A menu with no item is not drawn at all.
 */
export function RowMenu({
  label,
  items,
  className,
  defaultOpen = false,
}: {
  /** The button's name, e.g. "Actions for Sara Ali". */
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  readonly className?: string;
  /** Stories: open as drawn (S6e0). */
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    if (!defaultOpen) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, defaultOpen]);

  if (items.length === 0) return null;
  const close = () => setOpen(false);

  return (
    <span className={['tm-aie-menu', className].filter(Boolean).join(' ')}>
      <button
        ref={trigger}
        type="button"
        className="tm-aie-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open ? (
        <ul ref={menu} id={menuId} role="menu" className="tm-aie-menu__list">
          {items.map((item) => (
            <li
              key={item.key}
              role="none"
              className={
                item.danger ? 'tm-aie-menu__entry tm-aie-menu__entry--danger' : 'tm-aie-menu__entry'
              }
            >
              {item.href ? (
                <Link
                  role="menuitem"
                  className="tm-aie-menu__item"
                  href={item.href}
                  onClick={close}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="tm-aie-menu__item"
                  onClick={() => {
                    close();
                    item.onSelect?.();
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
