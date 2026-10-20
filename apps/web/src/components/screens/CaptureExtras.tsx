'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { WorkLabel } from '../../lib/api/work-labels';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_KINDS_LABEL,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentProblem,
  formatBytes,
} from '../../lib/api/uploads';
import { useT } from '../../lib/i18n/use-t';
import './capture-extras.css';

/**
 * The two rows the New work capsule (WK-10 "Quick capsule") gained beside its chips: **labels**
 * (the organization's work labels, x233, toggled as capsules) and **attachments** (files uploaded
 * through the existing upload pipeline and attached to the new item, x205). Both are pure
 * presentational controls — the screen owns the state and does the writes after the item exists,
 * because neither a label nor a file can hang off an item that has not been created yet.
 */

export interface CaptureLabelPickerProps {
  readonly labels: readonly WorkLabel[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (labelId: string) => void;
  /** Define a new organization label; the screen selects it once it exists. */
  readonly onCreate: (name: string) => void;
  readonly creating: boolean;
  readonly createError: string | null;
  readonly disabled?: boolean;
}

export function CaptureLabelPicker({
  labels,
  selected,
  onToggle,
  onCreate,
  creating,
  createError,
  disabled = false,
}: CaptureLabelPickerProps) {
  const t = useT();
  const headingId = useId();
  const inputId = useId();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const newInput = useRef<HTMLInputElement>(null);

  // Opening the field is the person's own click, so the caret follows it there.
  useEffect(() => {
    if (adding) newInput.current?.focus();
  }, [adding]);

  const submitNew = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    onCreate(trimmed);
    setName('');
    setAdding(false);
  };

  return (
    <div className="tm-capture-extra" role="group" aria-labelledby={headingId}>
      <span className="tm-capture-extra__label" id={headingId}>
        {t('CaptureExtras.labelsHeading')}
      </span>
      <div className="tm-capture-extra__chips">
        {labels.map((label) => (
          <button
            key={label.id}
            type="button"
            className="tm-chip tm-chip--compact"
            aria-pressed={selected.has(label.id)}
            disabled={disabled}
            onClick={() => onToggle(label.id)}
          >
            {label.name}
          </button>
        ))}
        {adding ? (
          <span className="tm-capture-extra__new">
            <label className="tm-visually-hidden" htmlFor={inputId}>
              {t('CaptureExtras.newLabelNameLabel')}
            </label>
            <input
              ref={newInput}
              id={inputId}
              className="tm-field__control tm-capture-extra__new-input"
              value={name}
              maxLength={60}
              placeholder={t('CaptureExtras.labelNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitNew();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setAdding(false);
                  setName('');
                }
              }}
            />
            <Button
              type="button"
              tone="outline"
              size="compact"
              disabled={creating || name.trim() === ''}
              onClick={submitNew}
            >
              {t('CaptureExtras.add')}
            </Button>
          </span>
        ) : (
          <button
            type="button"
            className="tm-chip tm-chip--compact tm-chip--dashed tm-capture-extra__add"
            disabled={disabled || creating}
            onClick={() => setAdding(true)}
          >
            {creating ? t('CaptureExtras.adding') : t('CaptureExtras.newLabel')}
          </button>
        )}
      </div>
      {labels.length === 0 && !adding ? (
        <p className="tm-capture-extra__hint">{t('CaptureExtras.noLabels')}</p>
      ) : null}
      {createError ? (
        <InlineAlert tone="danger" title={t('CaptureExtras.addLabelError')}>
          {createError}
        </InlineAlert>
      ) : null}
    </div>
  );
}

export interface CaptureAttachmentPickerProps {
  readonly files: readonly File[];
  readonly onAdd: (files: readonly File[]) => void;
  readonly onRemove: (index: number) => void;
  readonly disabled?: boolean;
}

/**
 * Pick files to attach. Files the API would refuse — empty, over the size ceiling, of a type the
 * verifier does not admit, or past the per-item count — are not added; each is named in a message.
 */
export function CaptureAttachmentPicker({
  files,
  onAdd,
  onRemove,
  disabled = false,
}: CaptureAttachmentPickerProps) {
  const t = useT();
  const headingId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);

  const accept = (picked: readonly File[]): void => {
    const room = MAX_ATTACHMENTS - files.length;
    const found: string[] = [];
    const kept: File[] = [];
    for (const file of picked) {
      const problem = attachmentProblem(file);
      if (problem) found.push(problem);
      else if (kept.length >= room) {
        found.push(`“${file.name}” was not added: up to ${MAX_ATTACHMENTS} files per item.`);
      } else kept.push(file);
    }
    setProblems(found);
    if (kept.length > 0) onAdd(kept);
  };

  return (
    <div className="tm-capture-extra" role="group" aria-labelledby={headingId}>
      <span className="tm-capture-extra__label" id={headingId}>
        {t('CaptureExtras.attachmentsHeading')}
      </span>
      <div className="tm-capture-extra__chips">
        {files.map((file, index) => (
          <span key={`${file.name}-${index}`} className="tm-chip tm-chip--compact">
            <span className="tm-capture-extra__file-name">{file.name}</span>
            <span className="tm-capture-extra__file-size">{formatBytes(file.size)}</span>
            <button
              type="button"
              className="tm-capture-extra__remove"
              aria-label={`${t('CaptureExtras.removeFilePrefix')}${file.name}`}
              disabled={disabled}
              onClick={() => onRemove(index)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="tm-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            accept(Array.from(event.target.files ?? []));
            // Let the same file be picked again after it is removed.
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="tm-chip tm-chip--compact tm-chip--dashed tm-capture-extra__add"
          aria-describedby={hintId}
          disabled={disabled || files.length >= MAX_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
        >
          {t('CaptureExtras.attachFiles')}
        </button>
      </div>
      <p className="tm-capture-extra__hint" id={hintId}>
        {ATTACHMENT_KINDS_LABEL}. Up to {MAX_ATTACHMENTS} files, {formatBytes(MAX_ATTACHMENT_BYTES)}{' '}
        each. Visible to your team only.
      </p>
      {problems.length > 0 ? (
        <InlineAlert tone="danger" title={t('CaptureExtras.someFilesError')}>
          {problems.join(' ')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
