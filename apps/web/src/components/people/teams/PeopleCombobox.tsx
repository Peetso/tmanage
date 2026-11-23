'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDismiss } from '../../work/use-dismiss';
import { ChevronDownIcon, PlusIcon } from '../../work/work-icons';
import { faceInitials } from './teams-model';

/** One row of the list: a person, or a team that adds its people. */
export interface ComboOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'person' | 'team';
}

export interface PeopleComboboxProps {
  /** The visible words in the box, and its accessible name unless `labelledBy` names one. */
  readonly placeholder: string;
  readonly labelledBy?: string;
  /** Rows for the typed letters; the caller filters (it knows who is taken). */
  readonly options: (query: string) => readonly ComboOption[];
  readonly onPick: (option: ComboOption) => void;
  /** Called the first time the list opens, so the people are read only when wanted. */
  readonly onOpen?: () => void;
  readonly loading?: boolean;
  readonly loadingText: string;
  /** Said in the list when no row is left. */
  readonly emptyText: string;
  /** The tag on a team row ("Team"). */
  readonly teamTag: string;
  /** `field`: Figma's "Add people to Design" row (plus, chevron). `chips`: the New team box. */
  readonly variant: 'field' | 'chips';
  /** The chosen people drawn before the input (chips variant). */
  readonly before?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * The people picker of the Teams page (Figma `WV2-05` "Add people to Design", `WV2-06` "Add people
 * or a team…"). WAI-ARIA APG "Combobox with listbox popup": the input owns the list through
 * `aria-controls` and `aria-activedescendant`; Down/Up move, Enter picks, Escape closes the list
 * first (the shared `useDismiss` rule), and focus never leaves the input.
 */
export function PeopleCombobox({
  placeholder,
  labelledBy,
  options,
  onPick,
  onOpen,
  loading = false,
  loadingText,
  emptyText,
  teamTag,
  variant,
  before,
  disabled = false,
}: PeopleComboboxProps) {
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rows = open ? options(query) : [];
  const current = rows[Math.min(active, rows.length - 1)];

  useDismiss(open, box, () => setOpen(false));

  const show = () => {
    if (disabled) return;
    if (!open) onOpen?.();
    setOpen(true);
  };

  const pick = (option: ComboOption) => {
    onPick(option);
    setQuery('');
    setActive(0);
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) show();
      else setActive((index) => Math.min(index + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && current) {
      event.preventDefault();
      pick(current);
    }
  };

  return (
    <div ref={box} className="tm-team-combo" data-variant={variant} data-open={open || undefined}>
      <div className="tm-team-combo__box">
        {variant === 'field' ? (
          <span className="tm-team-combo__lead" aria-hidden="true">
            <PlusIcon />
          </span>
        ) : null}
        {before}
        <input
          ref={input}
          className="tm-team-combo__input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': placeholder })}
          {...(open && current ? { 'aria-activedescendant': `${listId}-${current.id}` } : {})}
          placeholder={placeholder}
          value={query}
          dir="auto"
          disabled={disabled}
          onFocus={show}
          onClick={show}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            show();
          }}
          onKeyDown={onKeyDown}
        />
        {variant === 'field' ? (
          <button
            type="button"
            className="tm-team-combo__toggle"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onClick={() => (open ? setOpen(false) : (show(), input.current?.focus()))}
          >
            <ChevronDownIcon />
          </button>
        ) : null}
      </div>
      {open ? (
        <ul id={listId} role="listbox" className="tm-team-combo__list" aria-label={placeholder}>
          {loading ? (
            <li role="presentation" className="tm-team-combo__note">
              {loadingText}
            </li>
          ) : rows.length === 0 ? (
            <li role="presentation" className="tm-team-combo__note">
              {emptyText}
            </li>
          ) : (
            rows.map((option) => (
              // The keyboard path is the input's own (arrows + Enter over aria-activedescendant),
              // as in `@tmanage/ui` Combobox: focus never enters the listbox, so a key listener
              // here could never fire.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={`${option.kind}-${option.id}`}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={option === current}
                className="tm-team-combo__option"
                // Keep focus in the input: a press on a row picks without blurring it.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                <span className="tm-team-face" aria-hidden="true">
                  {faceInitials(option.label)}
                </span>
                <bdi className="tm-team-combo__name">{option.label}</bdi>
                {option.kind === 'team' ? (
                  <span className="tm-team-combo__tag">{teamTag}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
