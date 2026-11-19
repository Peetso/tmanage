'use client';

import { NavIcon } from '../icons/phone';
import { useMenuPopup } from './use-menu-popup';

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
 * closes it (`use-menu-popup.ts`).
 */
export function ActivityFilterMenu({
  label,
  menuLabel,
  options,
  value,
  active,
  onChange,
}: ActivityFilterMenuProps) {
  const { menuId, root, trigger, open, toggle, close, onMenuKey } = useMenuPopup('menuitemradio');

  return (
    <div ref={root} className="tm-act-menu">
      <button
        ref={trigger}
        type="button"
        className={active ? 'tm-chip tm-chip--active' : 'tm-chip'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
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
