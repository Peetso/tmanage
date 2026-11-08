'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import {
  addWorkItemWatchers,
  getWorkItemPeople,
  setWorkItemPeople,
  type WorkItemPeople,
} from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { workItemKeys } from '../../lib/query-keys';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useA6T, WorkDialogFrame } from './DueDatePicker';
import { initialsOf, useOwnerCandidates, type OwnerCandidate } from './OwnerPickerDialog';

type Row = 'doers' | 'supervisors' | 'watchers';

const ROWS: readonly Row[] = ['doers', 'supervisors', 'watchers'];
const LABEL: Record<Row, string> = {
  doers: 'WorkPeople.doers',
  supervisors: 'WorkPeople.supervisors',
  watchers: 'WorkPeople.watchers',
};
const PICK: Record<Row, string> = {
  doers: 'WorkPeople.pickDoers',
  supervisors: 'WorkPeople.pickSupervisors',
  watchers: 'WorkPeople.pickWatchers',
};
/** Avatars shown before the "+N" orb. */
const STACK = 3;

export interface WorkPeopleBlockProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly workItemId: string;
  readonly projectId: string;
  readonly projectName: string;
}

/**
 * **C26 — the people on a task (Figma R33 C26, 531:30917).** Three rows: Doers (the first is the
 * lead, the item's owner), Supervisors and Watchers, each an avatar stack with "Add". "Add" opens
 * one picker where several people are ticked at once. Doers and supervisors are replaced as a
 * set; watchers are only added here (anyone can still stop watching themselves).
 */
export function WorkPeopleBlock({
  api,
  organizationSlug,
  workItemId,
  projectId,
  projectName,
}: WorkPeopleBlockProps) {
  const t = useA6T();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const directory = useMembers(api, organizationSlug);
  const candidates = useOwnerCandidates(api, organizationSlug, projectId);
  const [picking, setPicking] = useState<Row | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const key = ['work-item-people', organizationSlug, workItemId] as const;

  const people = useQuery({
    queryKey: key,
    queryFn: () => getWorkItemPeople(api, organizationSlug, workItemId),
  });

  const save = useMutation({
    mutationFn: async ({ row, userIds }: { row: Row; userIds: readonly string[] }) => {
      if (row === 'watchers') await addWorkItemWatchers(api, organizationSlug, workItemId, userIds);
      else await setWorkItemPeople(api, organizationSlug, workItemId, row, userIds);
      return row;
    },
    onSuccess: (row) => {
      setPicking(null);
      setFailure(undefined);
      void queries.invalidateQueries({ queryKey: key });
      if (row === 'doers')
        void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      if (row === 'watchers') {
        void queries.invalidateQueries({
          queryKey: ['work-item-watchers', organizationSlug, workItemId],
        });
      }
    },
    onError: (error) => setFailure(describe(error)),
  });

  // Tolerate a partial answer (an older API, a stub): every list defaults to empty.
  const data: WorkItemPeople = {
    doerUserIds: people.data?.doerUserIds ?? [],
    supervisorUserIds: people.data?.supervisorUserIds ?? [],
    watcherUserIds: people.data?.watcherUserIds ?? [],
  };
  const idsOf = (row: Row): readonly string[] =>
    row === 'doers'
      ? data.doerUserIds
      : row === 'supervisors'
        ? data.supervisorUserIds
        : data.watcherUserIds;
  const nameOf = (userId: string) =>
    memberDisplayName(userId, directory.members, directory.isPending);
  const lead = data.doerUserIds[0];

  return (
    <section
      className="tm-wk-people-block"
      aria-label={t('WorkPeople.heading')}
      data-testid="work-item-people"
    >
      <p className="tm-wk-people-block__heading">{t('WorkPeople.heading')}</p>
      {ROWS.map((row) => {
        const ids = idsOf(row);
        return (
          <div key={row} className="tm-wk-people-row">
            <span className="tm-wk-people-row__label">{t(LABEL[row])}</span>
            {ids.length > 0 ? (
              <span className="tm-wk-stack" role="list">
                {ids.slice(0, STACK).map((id) => (
                  <span
                    key={id}
                    className="tm-wk-orb"
                    role="listitem"
                    title={nameOf(id)}
                    aria-label={nameOf(id)}
                  >
                    {initialsOf(nameOf(id))}
                  </span>
                ))}
                {ids.length > STACK ? (
                  <span className="tm-wk-orb" data-more="true" role="listitem">
                    +{ids.length - STACK}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="tm-wk-people-row__empty">{t('WorkPeople.nobody')}</span>
            )}
            {row === 'doers' && lead !== undefined ? (
              <span className="tm-wk-pill">{t('WorkPeople.lead', { name: nameOf(lead) })}</span>
            ) : null}
            <Button tone="outline" size="compact" onClick={() => setPicking(row)}>
              {t('WorkPeople.add')}
            </Button>
          </div>
        );
      })}
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkPeople.failure')} live>
          {failure}
        </InlineAlert>
      ) : null}
      {picking !== null ? (
        <PeoplePickerDialog
          title={t(PICK[picking])}
          projectName={projectName}
          candidates={
            picking === 'watchers'
              ? candidates.candidates.filter((c) => !data.watcherUserIds.includes(c.userId))
              : candidates.candidates
          }
          loading={candidates.loading}
          initial={picking === 'watchers' ? [] : idsOf(picking)}
          showLeadHint={picking === 'doers'}
          saving={save.isPending}
          onSave={(userIds) => save.mutate({ row: picking, userIds })}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </section>
  );
}

interface PeoplePickerDialogProps {
  readonly title: string;
  readonly projectName: string;
  readonly candidates: readonly OwnerCandidate[];
  readonly loading: boolean;
  readonly initial: readonly string[];
  readonly showLeadHint: boolean;
  readonly saving: boolean;
  readonly onSave: (userIds: readonly string[]) => void;
  readonly onClose: () => void;
}

/** The multi-select people picker: search, tick several at once, in the order ticked. */
function PeoplePickerDialog({
  title,
  projectName,
  candidates,
  loading,
  initial,
  showLeadHint,
  saving,
  onSave,
  onClose,
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
