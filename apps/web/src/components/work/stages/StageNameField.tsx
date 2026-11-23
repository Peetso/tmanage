'use client';

import { useId, useRef, type ReactNode } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { MAX_STAGE_NAME_LENGTH } from './stage-editor-model';

/**
 * A stage or stage-set name being typed or dictated (Figma W7 rename row `937:99028`, W8 New stage
 * set name `937:100415`): the box, then `Control/Voice` (the mic and the language chip the work
 * page's title uses, so one language choice serves every box). `stacked` draws the two lines of
 * the stage row (name, then voice) so the name keeps its full width; `inline` keeps them on one.
 *
 * Enter saves, Escape cancels (and is not passed on to the menu or dialog around it), and leaving
 * the box saves unless focus went to its own mic or language chip.
 */
export function StageNameField({
  api,
  organizationSlug,
  label,
  value,
  onChange,
  onSave,
  onCancel,
  error,
  layout = 'stacked',
  lead,
  placeholder,
  autoFocus = true,
  id,
}: {
  api: ApiClient;
  organizationSlug: string;
  /** The box's accessible name ("Stage name", "Stage set name"). */
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Enter, or leaving the box. Absent in a form, which saves on submit. */
  onSave?: () => void;
  onCancel?: () => void;
  error?: string | undefined;
  layout?: 'stacked' | 'inline';
  /** Drawn before the box (the stage's dot). */
  lead?: ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}) {
  const own = useId();
  const inputId = id ?? own;
  const errorId = `${inputId}-error`;
  const box = useRef<HTMLDivElement>(null);
  const voice = useVoiceInput({ api, organizationSlug, value, onChange });
  return (
    <div
      ref={box}
      className="tm-stg-name"
      data-layout={layout}
      data-invalid={error ? true : undefined}
    >
      <span className="tm-stg-name__line">
        {lead}
        <input
          id={inputId}
          className="tm-stg-name__input"
          aria-label={label}
          value={value}
          maxLength={MAX_STAGE_NAME_LENGTH}
          dir="auto"
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          // The box opens because the person chose Rename or Add stage: typing is next.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSave) {
              event.preventDefault();
              onSave();
            } else if (event.key === 'Escape' && onCancel) {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && box.current?.contains(next)) return;
            // A language menu opened from the chip lives outside the box; it keeps the edit open.
            if (next instanceof Element && next.closest('[role="listbox"], [role="menu"]')) return;
            onSave?.();
          }}
        />
      </span>
      <span className="tm-stg-name__voice">
        <VoiceControl input={voice} />
      </span>
      {error ? (
        <span id={errorId} className="tm-stg-name__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
