'use client';

import { Checkbox } from '@tmanage/ui';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import './viewer-versions.css';

export interface CarryForwardListProps {
  /** The open threads on the version the new one replaces. */
  readonly threads: readonly ReviewThread[];
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (threadId: string) => void;
  readonly fromNo: number;
  readonly toNo: number;
}

/**
 * R4 slice 11 — the "carry comments forward" choice (Figma V-32 `463:28615`): "3 open comments on
 * v2 — carry them to v3?" and one row per open comment, its pin number and first words, each with
 * a checkbox (untick the ones the new version already fixes). Shown inside the upload dialog under
 * the "Carry the open comments" switch, so the choice is made before the upload, in one place.
 */
export function CarryForwardList({
  threads,
  chosen,
  onToggle,
  fromNo,
  toNo,
}: CarryForwardListProps) {
  const t = useT();
  if (threads.length === 0) return null;
  return (
    <fieldset className="tm-carry">
      <legend className="tm-carry__legend">
        {t('ViewerUpload.carryQuestion')
          .replace('{count}', String(threads.length))
          .replace('{from}', String(fromNo))
          .replace('{to}', String(toNo))}
      </legend>
      <ul className="tm-carry__list">
        {threads.map((thread) => (
          <li key={thread.id} className="tm-carry__item">
            <span className="tm-viewer-card-pin" aria-hidden="true">
              {thread.number}
            </span>
            <Checkbox
              label={
                <span dir="auto">
                  {t('ViewerUpload.carryItem')
                    .replace('{no}', String(thread.number))
                    .replace('{text}', firstWords(thread.comments[0]?.body ?? ''))}
                </span>
              }
              checked={chosen.has(thread.id)}
              onChange={() => onToggle(thread.id)}
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** The start of a comment, cut on a word near 80 characters. */
export function firstWords(body: string, limit = 80): string {
  const flat = body.replace(/\s+/gu, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
