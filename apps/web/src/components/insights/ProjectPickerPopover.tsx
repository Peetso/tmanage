'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Checkbox } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import './project-picker.css';

/**
 * A13's catalog lookup. The keys arrive through `i18n-A13.*.json` and are merged into the catalogs
 * by the committer; until then `translate` falls back to the key, so the cast is only a type bridge.
 */
export function useA13T(): (
  key: string,
  vars?: Readonly<Record<string, string | number>>,
) => string {
  const t = useT();
  return useCallback(
    (key: string, vars?: Readonly<Record<string, string | number>>) => {
      let text = t(key as MessageKey);
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [t],
  );
}

/** One project the report can be narrowed to. */
export interface PickerProject {
  readonly projectId: string;
  readonly name: string;
}

export interface ProjectPickerPopoverProps {
  readonly projects: readonly PickerProject[];
  /** The ids in the report today; empty means every project. */
  readonly value: readonly string[];
  readonly onApply: (projectIds: readonly string[]) => void;
  readonly onClose: () => void;
}

/** The primary button's label: Arabic counts one, two, few and many differently. */
export function showLabelKey(count: number): string {
  if (count === 0) return 'InsightsPicker.showAll';
  if (count === 1) return 'InsightsPicker.showOne';
  if (count === 2) return 'InsightsPicker.showTwo';
  if (count <= 10) return 'InsightsPicker.showFew';
  return 'InsightsPicker.showMany';
}

/**
 * **Projects in this report (A13, Figma fq12-insights-project-picker).**
 *
 * A search box (⌘K focuses it), "All projects" and one checkbox per project. Nothing is applied
 * until the primary button, which names how many projects the report will show; Clear empties
 * the draft back to every project.
 */
export function ProjectPickerPopover({
  projects,
  value,
  onApply,
  onClose,
}: ProjectPickerPopoverProps) {
  const t = useA13T();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<readonly string[]>(value);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.current?.focus();
      } else if (event.key === 'Escape') {
        onClose();
      }
    };
    const onPointer = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const shown =
    needle === '' ? projects : projects.filter((p) => p.name.toLowerCase().includes(needle));

  const toggle = (projectId: string) =>
    setDraft((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );

  return (
    <div
      ref={panel}
      className="tm-ins-picker"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="tm-ins-picker__title">
        {t('InsightsPicker.title')}
      </h2>

      <label className="tm-ins-picker__search">
        <svg
          className="tm-ins-picker__search-icon"
          viewBox="0 0 20 20"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="m13 13 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <input
          ref={search}
          type="search"
          value={query}
          placeholder={t('InsightsPicker.search')}
          aria-label={t('InsightsPicker.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd className="tm-ins-picker__key" aria-hidden="true">
          ⌘K
        </kbd>
      </label>

      <ul className="tm-ins-picker__list">
        {needle === '' ? (
          <li>
            <Checkbox
              label={t('InsightsPicker.all')}
              checked={draft.length === 0}
              onChange={() => setDraft([])}
            />
          </li>
        ) : null}
        {shown.map((project) => (
          <li key={project.projectId}>
            <Checkbox
              label={project.name}
              checked={draft.includes(project.projectId)}
              onChange={() => toggle(project.projectId)}
            />
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="tm-ins-picker__empty">{t('InsightsPicker.noMatch')}</li>
        ) : null}
      </ul>

      <div className="tm-ins-picker__foot">
        <Button tone="text" onClick={() => setDraft([])}>
          {t('InsightsPicker.clear')}
        </Button>
        <Button tone="ink" size="accessible" onClick={() => onApply(draft)}>
          {t(showLabelKey(draft.length), { count: draft.length })}
        </Button>
      </div>
    </div>
  );
}
