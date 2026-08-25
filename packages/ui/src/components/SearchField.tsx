import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type'
> {
  /** The accessible name. Visually hidden by default — see `labelVisible`. */
  label: ReactNode;
  /** Show the label above the control instead of hiding it. */
  labelVisible?: boolean;
}

/**
 * Search input.
 *
 * `type="search"`, so the browser and the platform know what it is. The label is hidden
 * rather than absent: the search capsule in the design artifacts carries a glyph and no
 * visible caption, and a hidden `<label>` gives the screen-reader user the name the
 * sighted user gets from the glyph and the position.
 */
export function SearchField({ label, labelVisible = false, className, ...rest }: SearchFieldProps) {
  const id = useId();

  return (
    <span className={['tm-search-field', className].filter(Boolean).join(' ')}>
      <label className={labelVisible ? 'tm-field__label' : 'tm-visually-hidden'} htmlFor={id}>
        {label}
      </label>
      <span className="tm-search-field__glyph" aria-hidden="true">
        ⌕
      </span>
      <input
        {...rest}
        id={id}
        type="search"
        className="tm-field__control tm-search-field__control"
      />
    </span>
  );
}
