'use client';

import { useId, useState } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { WorkItemPeople } from '../../lib/api/work-items';
import { useA6T, WorkDialogFrame } from './DueDatePicker';
import { initialsOf, type OwnerCandidate } from './OwnerPickerDialog';
import { PickerTeams } from './PickerTeams';
import { PersonAvatar } from '../people/PersonAvatar';

/** Avatars shown before the "+N" orb. */
const STACK = 3;

/** The query key the people block and the detail screen's "Mark done" share. */
export function workItemPeopleKey(organizationSlug: string, workItemId: string) {
  return ['work-item-people', organizationSlug, workItemId] as const;
}

/**
 * C27 — whether "Mark done" must stop in internal review: the task has supervisors and the
 * reader is not one of them, so a supervisor approves it (the API refuses anyone else's done).
 */
export function needsSupervisorApproval(people: WorkItemPeople | undefined): boolean {
  if (people === undefined || people.supervisorUserIds.length === 0) return false;
  return (
    people.viewerUserId === undefined || !people.supervisorUserIds.includes(people.viewerUserId)
  );
}

/**
 * C27 — the doer avatar stack on a list row or a board card: at most three initials, then "+N".
 * `doerUserIds` is the list read's, lead first; an older answer without it falls back to the owner.
 */
export function DoerStack({
  doerUserIds,
  ownerUserId,
  nameOf,
}: {
  readonly doerUserIds: readonly string[] | undefined;
  readonly ownerUserId: string | null;
  readonly nameOf: (userId: string) => string;
}) {
  const ids = doerUserIds ?? (ownerUserId === null ? [] : [ownerUserId]);
  if (ids.length === 0) return null;
  const names = ids.map(nameOf);
  return (
    <span className="tm-wk-stack" title={names.join(', ')} data-testid="doer-stack">
      {ids.slice(0, STACK).map((id, index) => (
        <PersonAvatar
          key={id}
          userId={id}
          name={names[index] ?? ''}
          className="tm-wk-orb"
          size="compact"
          decorative
          fallback={
            <span className="tm-wk-orb" aria-hidden="true">
              {initialsOf(names[index] ?? '')}
            </span>
          }
        />
      ))}
      {ids.length > STACK ? (
        <span className="tm-wk-orb" data-more="true" aria-hidden="true">
          +{ids.length - STACK}
        </span>
      ) : null}
      <span className="tm-visually-hidden">{names.join(', ')}</span>
    </span>
  );
}

/** C27 — "Send back": the task returns to in progress, with an optional note for the doers. */
export function SendBackDialog({
  saving,
  onSend,
  onClose,
}: {
  readonly saving: boolean;
  readonly onSend: (note: string) => void;
  readonly onClose: () => void;
}) {
  const t = useA6T();
  const titleId = useId();
  const [note, setNote] = useState('');
  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {t('WorkPeople.sendBackTitle')}
      </h2>
      <div className="tm-field">
        <label className="tm-field__label" htmlFor={`${titleId}-note`}>
          {t('WorkPeople.sendBackNote')}
        </label>
        <textarea
          id={`${titleId}-note`}
          className="tm-field__control tm-wk-textarea"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('WorkA6.cancel')}
        </Button>
        <Button
          tone="ink"
          size="accessible"
          loading={saving}
          loadingLabel={t('WorkA6.saving')}
          onClick={() => onSend(note)}
        >
          {t('WorkPeople.sendBack')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}

interface PeoplePickerDialogProps {
  readonly title: string;
  readonly projectName: string;
  readonly candidates: readonly OwnerCandidate[];
  readonly loading: boolean;
  readonly initial: readonly string[];
  readonly showLeadHint: boolean;
  /** C27: the watchers picker — unticking someone stops them watching. */
  readonly removeHint?: boolean;
  readonly saving: boolean;
  readonly onSave: (userIds: readonly string[]) => void;
  readonly onClose: () => void;
  /** Offer the workspace's teams above the people: a press ticks a whole team at once. */
  readonly teams?: { readonly api: ApiClient; readonly organizationSlug: string };
}

/** The multi-select people picker: search, tick several at once, in the order ticked. */
export function PeoplePickerDialog({
  title,
  projectName,
  candidates,
  loading,
  initial,
  showLeadHint,
  removeHint = false,
  saving,
  onSave,
  onClose,
  teams,
}: PeoplePickerDialogProps) {
  const t = useA6T();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<readonly string[]>(initial);
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ''
      ? candidates
      : candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(needle));
  const toggle = (userId: string) =>
    setTicked((now) =>
      now.includes(userId) ? now.filter((id) => id !== userId) : [...now, userId],
    );

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {title}
      </h2>
      <p className="tm-wk-dialog__lede">{t('OwnerPicker.onlyProject', { project: projectName })}</p>
      <label className="tm-wk-search">
        <span className="tm-wk-search__icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          value={query}
          placeholder={t('WorkPeople.search')}
          aria-label={t('WorkPeople.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {teams ? (
        <PickerTeams
          api={teams.api}
          organizationSlug={teams.organizationSlug}
          needle={needle}
          candidateIds={new Set(candidates.map((candidate) => candidate.userId))}
          onAdd={(userIds) =>
            setTicked((now) => [...now, ...userIds.filter((userId) => !now.includes(userId))])
          }
        />
      ) : null}
      <ul className="tm-wk-people" aria-label={t('OwnerPicker.listLabel')} aria-busy={loading}>
        {shown.map((candidate) => {
          const on = ticked.includes(candidate.userId);
          return (
            <li key={candidate.userId}>
              <button
                type="button"
                className="tm-wk-person"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(candidate.userId)}
              >
                <span className="tm-wk-orb" aria-hidden="true">
                  {initialsOf(candidate.displayName)}
                </span>
                <span className="tm-wk-person__text">
                  <span className="tm-wk-person__name">{candidate.displayName}</span>
                  {candidate.subtitle ? (
                    <span className="tm-wk-person__role">{candidate.subtitle}</span>
                  ) : null}
                </span>
                {on ? (
                  <span className="tm-wk-person__tick" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {!loading && shown.length === 0 ? (
          <li className="tm-wk-people__empty">{t('OwnerPicker.none')}</li>
        ) : null}
      </ul>
      <p className="tm-wk-dialog__lede">
        {t('WorkPeople.selected', { count: ticked.length })}
        {showLeadHint ? ` · ${t('WorkPeople.leadHint')}` : ''}
        {removeHint ? ` · ${t('WorkPeople.removeHint')}` : ''}
      </p>
      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('WorkA6.cancel')}
        </Button>
        <Button
          tone="ink"
          size="accessible"
          loading={saving}
          loadingLabel={t('WorkA6.saving')}
          onClick={() => onSave(ticked)}
        >
          {t('WorkPeople.done')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}
