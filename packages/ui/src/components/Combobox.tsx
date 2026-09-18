import {
  useEffect,
  useId,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface ComboboxOption {
  /** The stable value a form receives. */
  readonly value: string;
  /** The text a person reads, types against and hears. */
  readonly label: string;
}

export interface ComboboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | 'id'
  | 'type'
  | 'role'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'aria-invalid'
  | 'aria-describedby'
  | 'children'
> {
  /** A real `<label>`, always rendered and always associated. */
  label: ReactNode;
  /** Persistent help text, read with the control. */
  hint?: ReactNode;
  /** The validation message. Its presence is what sets `aria-invalid`, as on `Field`. */
  error?: ReactNode;
  /** The full option list. The component filters it as the person types. */
  options: readonly ComboboxOption[];
  /** The selected option's value, or `''` for none. */
  value?: string;
  /** Called with the chosen option's value when one is picked, `''` when cleared. */
  onValueChange?: (value: string) => void;
  /**
   * Called with the text as it is typed, before any option is chosen.
   *
   * For a list that cannot be held in the browser — a staff directory, a project list — where
   * the typed text has to reach the server. The component keeps filtering the options it was
   * given either way; this only lets a caller widen the set it hands back. It is deliberately
   * not the input's `onChange`: that one carries a DOM event and is the component's own.
   */
  onQueryChange?: (text: string) => void;
  /** Shown inside the popup when the typed text matches nothing. */
  emptyLabel?: string;
  /**
   * Renders the popup open with no interaction. For the visual harness, which cannot
   * type, and for nothing else — the same narrow purpose as `Tooltip`'s `defaultOpen`.
   */
  defaultOpen?: boolean;
}

/**
 * The combobox — the WAI-ARIA editable combobox pattern over a text input and a listbox,
 * for the lists a `Select` cannot carry: people, projects, anything long enough that
 * typing beats scrolling.
 *
 * The pattern's load-bearing choices, each of which a test pins:
 *
 * - **DOM focus never leaves the input.** The highlighted option is a *virtual* focus,
 *   carried by `aria-activedescendant` and painted by `data-active`; arrow keys move it
 *   (ArrowDown enters at the top, ArrowUp at the bottom), the person keeps typing.
 *   Moving real focus into the popup is how a combobox loses the very thing it is for.
 * - `aria-expanded` tells the truth on the input, `aria-controls` names the listbox,
 *   `aria-autocomplete="list"` says what kind of help appears, and each option is
 *   `role="option"` with `aria-selected` on the chosen one. Option ids are built from
 *   the option's *index*, never its value — a value is form data and may contain
 *   anything, and an id with a space in it breaks `aria-activedescendant` silently.
 * - **Escape closes without selecting; Enter selects the active option.** While the
 *   popup is open, Enter never reaches a surrounding form — a person filtering a list
 *   who presses Enter is working the popup, not submitting half-filled data. Selecting
 *   puts the option's *label* in the input and hands the *value* to `onValueChange` —
 *   the person reads words, the form receives ids.
 * - The listbox swallows **mousedown**, so neither clicking an option nor grabbing the
 *   scrollbar blurs the input — the popup stays put and the option is chosen on the
 *   click that follows. `pointerdown` is deliberately left alone: cancelling it is what
 *   makes a list unscrollable by touch.
 * - **The text and the value are never allowed to disagree.** The committed label tracks
 *   the `value` prop (including a value that changes after mount, and options that
 *   arrive after mount), and blur with half-edited text reverts to it: a field showing
 *   "Nadia Rahma" while the form still holds Nadia Rahman's id is the defect, and the
 *   form is the truth.
 * - Filtering is a case-insensitive substring over the labels; a filter that matches
 *   nothing keeps the popup open and says so, because a popup that silently vanishes
 *   reads as broken.
 */
export function Combobox({
  label,
  hint,
  error,
  options,
  value,
  onValueChange,
  onQueryChange,
  emptyLabel = 'No matches',
  defaultOpen = false,
  className,
  required,
  ...rest
}: ComboboxProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const listboxId = `${id}-listbox`;

  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected ? selected.label : '';

  // `committed` is the label of the last real selection; `text` is what the person sees
  // and may be mid-edit. Both re-derive when the controlled `value` (or the option list
  // resolving it) changes — the render-time-sync pattern, not an effect, so the old
  // label is never painted first.
  const [committed, setCommitted] = useState(selectedLabel);
  const [text, setText] = useState(selectedLabel);
  const [syncedLabel, setSyncedLabel] = useState(value === undefined ? null : selectedLabel);
  if (value !== undefined && syncedLabel !== selectedLabel) {
    setSyncedLabel(selectedLabel);
    setCommitted(selectedLabel);
    setText(selectedLabel);
  }

  const [open, setOpen] = useState(defaultOpen);
  const [activeIndex, setActiveIndex] = useState(-1);

  const query = text.trim().toLowerCase();
  const filtered =
    open && query !== '' && text !== committed
      ? options.filter((option) => option.label.toLowerCase().includes(query))
      : [...options];

  const activeOption = open ? filtered[activeIndex] : undefined;
  const activeOptionId = activeOption ? `${id}-option-${activeIndex}` : undefined;

  // Keep the virtual focus visible in a scrolling listbox. jsdom has no scrolling, hence
  // the optional call.
  useEffect(() => {
    if (activeOptionId) {
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeOptionId]);

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const choose = (option: ComboboxOption) => {
    setCommitted(option.label);
    setText(option.label);
    onValueChange?.(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const entry = event.key === 'ArrowDown' ? 0 : filtered.length - 1;
      if (!open) {
        setOpen(true);
        setActiveIndex(entry);
        return;
      }
      if (filtered.length === 0) {
        return;
      }
      setActiveIndex((index) => {
        if (index === -1) {
          return entry;
        }
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (index + delta + filtered.length) % filtered.length;
      });
      return;
    }

    if (event.key === 'Enter' && open) {
      // Always swallowed while open — see the component comment on forms.
      event.preventDefault();
      const active = filtered[activeIndex];
      if (active) {
        choose(active);
      } else {
        close();
      }
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  };

  const onBlur = (event: FocusEvent<HTMLInputElement>) => {
    rest.onBlur?.(event);
    close();
    if (text !== committed) {
      setText(committed);
    }
  };

  return (
    <div className={['tm-field', className].filter(Boolean).join(' ')}>
      <label className="tm-field__label" htmlFor={id}>
        {label}
        {required === true ? (
          <span className="tm-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <span className="tm-combobox">
        <input
          {...rest}
          id={id}
          type="text"
          role="combobox"
          required={required}
          className="tm-field__control tm-combobox__control"
          value={text}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          autoComplete="off"
          onChange={(event) => {
            setText(event.currentTarget.value);
            setOpen(true);
            setActiveIndex(-1);
            onQueryChange?.(event.currentTarget.value);
            if (event.currentTarget.value === '') {
              setCommitted('');
              onValueChange?.('');
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <span className="tm-select__glyph" aria-hidden="true">
          ▾
        </span>

        <ul
          role="listbox"
          id={listboxId}
          aria-label={typeof label === 'string' ? `${label} options` : undefined}
          className="tm-combobox__listbox"
          data-open={open || undefined}
          onMouseDown={(event) => {
            // Options and scrollbar alike: interacting with the popup must not blur the
            // input. mousedown, not pointerdown — see the component comment on touch.
            event.preventDefault();
          }}
        >
          {open && filtered.length === 0 ? (
            <li className="tm-combobox__empty" role="presentation">
              {emptyLabel}
            </li>
          ) : null}
          {open
            ? filtered.map((option, index) => (
                // The keyboard path is the input's own (arrows + Enter over
                // aria-activedescendant) — a key listener here could never fire, since
                // DOM focus never enters the listbox by design.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={option.value}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={option.value === value || undefined}
                  data-active={index === activeIndex || undefined}
                  className="tm-combobox__option"
                  onClick={() => choose(option)}
                >
                  {option.label}
                </li>
              ))
            : null}
        </ul>

        {/*
          The visible empty row is presentation; this is its announcement. The live
          region exists from mount and only its text changes, because a live region
          inserted together with its first content is routinely not announced.
        */}
        <span className="tm-visually-hidden" role="status">
          {open && filtered.length === 0 ? emptyLabel : ''}
        </span>
      </span>

      {hint ? (
        <span className="tm-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}

      {error ? (
        <span className="tm-field__error" id={errorId}>
          <span className="tm-inline-alert__glyph" aria-hidden="true">
            !
          </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}
