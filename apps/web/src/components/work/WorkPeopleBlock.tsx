'use client';

import { useId, useState } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { WorkItemPeople } from '../../lib/api/work-items';
import { useA6T, WorkDialogFrame } from './DueDatePicker';
import { initialsOf, type OwnerCandidate } from './OwnerPickerDialog';
import { PickerTeams } from './PickerTeams';
import { PersonAvatar } from '../people/PersonAvatar';
import { useTOr } from '../../lib/i18n/use-t-or';
import { AiCandidateRow, AiPeopleNote, PickerGroupHeading } from './AiPickerRows';

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
  /**
   * 60-08 (S7): AI employees in this picker — `offer` (Doers: their own section after People, at
   * most one ticked), `refuse` (Supervisor: people only, with "AI employees can't supervise").
   * Absent: people only (Watchers).
   */
  readonly ai?: 'offer' | 'refuse';
  /** 60-08: whether the reader may make an AI employee the doer here (absent: the server decides). */
  readonly canAssignAi?: boolean;
  /** 60-08: an AI employee does this work, so a person must stay ticked (S7b). */
  readonly requirePerson?: boolean;
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
  ai,
  canAssignAi,
  requirePerson = false,
}: PeoplePickerDialogProps) {
  const t = useA6T();
  const tOr = useTOr();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<readonly string[]>(initial);
  const needle = query.trim().toLowerCase();
  const matching =
    needle === ''
      ? candidates
      : candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(needle));
  // 60-08: people first, then (Doers only) the AI employees in their own section.
  const aiIds = new Set(
    candidates.filter((candidate) => candidate.kind === 'ai').map((c) => c.userId),
  );
  const shown = matching.filter((candidate) => candidate.kind !== 'ai');
  const shownAi =
    ai === 'offer'
      ? matching.filter(
          (candidate) =>
            candidate.kind === 'ai' && (canAssignAi !== false || ticked.includes(candidate.userId)),
        )
      : [];
  const grouped = ai !== undefined && aiIds.size > 0;
  const peopleTicked = ticked.filter((id) => !aiIds.has(id)).length;
  const toggle = (userId: string) =>
    setTicked((now) =>
      now.includes(userId) ? now.filter((id) => id !== userId) : [...now, userId],
    );
  // One open AI assignment per task: ticking an AI employee unticks any other one.
  const toggleAi = (userId: string) =>
    setTicked((now) =>
      now.includes(userId)
        ? now.filter((id) => id !== userId)
        : [...now.filter((id) => !aiIds.has(id)), userId],
    );
  const searchLabel = !grouped
    ? t('WorkPeople.search')
    : ai === 'offer'
      ? tOr('AiPickers.searchAll', 'Search people, teams or AI')
      : tOr('AiPickers.searchPeople', 'Search people');

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      {/* 60-08 (S7 phone): `data-people-picker` lets the frame open as a bottom sheet on a phone. */}
      <h2 id={titleId} className="tm-wk-dialog__title" data-people-picker="">
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
          placeholder={searchLabel}
          aria-label={searchLabel}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {teams ? (
        <PickerTeams
          api={teams.api}
          organizationSlug={teams.organizationSlug}
          {...(grouped ? { heading: tOr('AiPickers.teams', 'Teams') } : {})}
          needle={needle}
          candidateIds={new Set(candidates.map((candidate) => candidate.userId))}
          onAdd={(userIds) =>
            setTicked((now) => [...now, ...userIds.filter((userId) => !now.includes(userId))])
          }
        />
      ) : null}
      {grouped ? (
        <PickerGroupHeading id={`${titleId}-people`}>
          {tOr('AiPickers.people', 'People')}
        </PickerGroupHeading>
      ) : null}
      <ul
        className="tm-wk-people"
        {...(grouped
          ? { 'aria-labelledby': `${titleId}-people` }
          : { 'aria-label': t('OwnerPicker.listLabel') })}
        aria-busy={loading}
      >
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
        {!loading && shown.length === 0 && shownAi.length === 0 ? (
          <li className="tm-wk-people__empty">{t('OwnerPicker.none')}</li>
        ) : null}
      </ul>
      {shownAi.length > 0 ? (
        <>
          <PickerGroupHeading id={`${titleId}-ai`}>
            {tOr('AiPickers.aiEmployees', 'AI employees')}
          </PickerGroupHeading>
          <ul className="tm-wk-people" aria-labelledby={`${titleId}-ai`}>
            {shownAi.map((candidate) => (
              <li key={candidate.userId}>
                <AiCandidateRow
                  candidate={candidate}
                  ticked={ticked.includes(candidate.userId)}
                  onToggle={toggleAi}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {ai === 'refuse' && grouped ? (
        <AiPeopleNote testId="ai-cant-supervise">
          {tOr('AiPickers.cantSupervise', 'AI employees can’t supervise.')}
        </AiPeopleNote>
      ) : null}
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
          disabled={requirePerson && peopleTicked === 0}
          onClick={() => onSave(ticked)}
        >
          {t('WorkPeople.done')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}
