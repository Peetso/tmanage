'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { NavIcon } from '../icons/phone';

export interface ActivityFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface ActivityFilterMenuProps {
  /** The chip's words, e.g. "Person: Anyone". */
  readonly label: string;
  /** The menu's accessible name, e.g. "Person". */
  readonly menuLabel: string;
  readonly options: readonly ActivityFilterOption[];
  readonly value: string;
  /** Tinted like a selected chip when a non-default choice is made. */
  readonly active: boolean;
  readonly onChange: (value: string) => void;
}

/**
 * 62-A2 (B09) — the Person and date chips of the Activity tab (review FIGMA-D fix 4): a chip with a
 * chevron that opens a one-choice menu (`menuitemradio`, the current one checked with an icon, not
 * tint alone). Escape and a pick return focus to the chip; arrows move inside; a click outside
 * closes it. Same keyboard model as the project Export menu.
 */
export function ActivityFilterMenu({
  label,
  menuLabel,
  options,
  value,
  active,
  onChange,
}: ActivityFilterMenuProps) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const checked = root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div ref={root} className="tm-act-menu">
      <button
        ref={trigger}
        type="button"
        className={active ? 'tm-chip tm-chip--active' : 'tm-chip'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tm-chip__label">{label}</span>
        <NavIcon name="chevronDown" size={16} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={menuLabel}
          className="tm-act-menu__list"
          onKeyDown={onMenuKey}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className="tm-act-menu__item"
              onClick={() => {
                onChange(option.value);
                close();
              }}
            >
              <span className="tm-act-menu__check">
                {option.value === value ? <NavIcon name="check" size={16} /> : null}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
