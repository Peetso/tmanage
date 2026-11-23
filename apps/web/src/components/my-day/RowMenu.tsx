'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import '../shell/command-palette-v2.css';

/** One entry of a row's "⋯" menu: a link, or an action run on this page. */
export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
  readonly onSelect?: () => void;
}

/**
 * **The "⋯" orb of a My Day card or row** (spec MYDAY-V4 §5 "Row actions", Fable review fix 1).
 * Drawn as the old 32 px orb (`.tm-home-orb`, a copy of the card's "↗" orb `351:2121`) and opened
 * as the shell's own menu panel (`.tm-new-menu__panel`), so it adds no new look.
 *
 * A WAI-ARIA APG menu button: Enter, Space or ArrowDown open it on the first item, ArrowUp on the
 * last; the arrows, Home and End move; Escape closes and returns focus to the orb; Tab closes; a
 * press outside closes it.
 */
export function RowMenu({
  label,
  items,
}: {
  /** The orb's accessible name, "More actions: {title}". */
  readonly label: string;
  readonly items: readonly RowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (open) itemRefs.current[focus]?.focus();
  }, [open, focus]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  if (items.length === 0) return null;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1;
    if (event.key === 'ArrowDown') setFocus((index) => (index >= last ? 0 : index + 1));
    else if (event.key === 'ArrowUp') setFocus((index) => (index <= 0 ? last : index - 1));
    else if (event.key === 'Home') setFocus(0);
    else if (event.key === 'End') setFocus(last);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  return (
    <div className="tm-new-menu tm-home-more" ref={root}>
      <button
        ref={button}
        type="button"
        className="tm-home-orb tm-home-more__orb"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setFocus(0);
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setFocus(event.key === 'ArrowDown' ? 0 : items.length - 1);
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className="tm-new-menu__panel"
          onKeyDown={onMenuKey}
        >
          {items.map((item, index) =>
            item.href ? (
              <Link
                key={item.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                role="menuitem"
                tabIndex={index === focus ? 0 : -1}
                href={item.href}
                className="tm-new-menu__item"
              >
                {item.label}
              </Link>
            ) : (
              <button
                key={item.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === focus ? 0 : -1}
                className="tm-new-menu__item"
                onClick={() => {
                  close(true);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
