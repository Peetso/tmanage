'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { getWorkItemRecurrence } from '../../../lib/api/work-item-recurrence';
import {
  addWorkItemWatchers,
  getWorkItemEstimate,
  getWorkItemPeople,
  listItemLinks,
  removeWorkItemWatcher,
  setWorkItemPeople,
  type WorkItemSummary,
} from '../../../lib/api/work-items';
import {
  assignItemLabel,
  listItemLabels,
  listWorkLabels,
  removeItemLabel,
} from '../../../lib/api/work-labels';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { dayToInstant } from '../../../lib/work-item-presentation';
import { formatDuration } from '../../../lib/i18n/duration';
import { memberDisplayName } from '../../../lib/members-presentation';
import { workItemKeys } from '../../../lib/query-keys';
import { useMembers } from '../../../lib/use-members';
import { WorkItemRecurrencePanel } from '../../screens/WorkItemRecurrencePanel';
import { WorkItemReminderView } from '../../screens/WorkItemReminderView';
import { dayOf, DueDatePicker, formatChipDay, useA6T } from '../DueDatePicker';
import { initialsOf, useOwnerCandidates } from '../OwnerPickerDialog';
import { PeoplePickerDialog, workItemPeopleKey } from '../WorkPeopleBlock';
import { WorkStageControl } from '../stages/WorkStageControl';
import type { WorkStages } from '../stages/use-work-stages';
import {
  CalendarIcon,
  ChevronDownIcon,
  CheckIcon,
  EyeIcon,
  FolderIcon,
  ForwardIcon,
  InfoIcon,
  PlayIcon,
  PlusIcon,
} from '../work-icons';
import { PanelRow } from './PanelRow';

/** Faces drawn in a panel row before the first name and "+N" (Figma `Panel/Row` people). */
const FACES = 3;

/** The rows of the panel, for the phone's "Show all 15". */
const PANEL_ROWS = 15;

export interface WorkPropertiesPanelProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly item: WorkItemSummary;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly projectName: string;
  readonly stages: WorkStages;
  /** The client company names this work is shown to ("Internal" when none). */
  readonly clientNames: readonly string[];
  readonly now?: Date;
  readonly saving: boolean;
  readonly onEdit: (changes: {
    readonly projectId?: string;
    readonly startAt?: string | null;
    readonly dueAt?: string | null;
  }) => void;
  readonly onChanged: (next: WorkItemSummary) => void;
  /** "Who sees it" and Client: the audience editor the page owns (widening is confirmed). */
  readonly audienceEditor: (close: () => void) => ReactNode;
  /** Status: the state-move form the page owns (blocked needs a reason and an ask). */
  readonly statusEditor: (close: () => void) => ReactNode;
}

/**
 * The work's properties panel (Figma `933:95423`, panel `--properties-panel` 360, rows 32): every
 * property in the same order and words as create — Project, Stage, Doers, Supervisor, Due,
 * Client, Who sees it, Start, Labels, Repeats, Watchers, Time, Reminder, Links, Status — each
 * edited in place. It replaces the old "Edit details" dialog and the stacked cards (plan §4.3).
 */
export function WorkPropertiesPanel({
  api,
  organizationSlug,
  item,
  projects,
  projectName,
  stages,
  clientNames,
  now,
  saving,
  onEdit,
  onChanged,
  audienceEditor,
  statusEditor,
}: WorkPropertiesPanelProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const directory = useMembers(api, organizationSlug);
  const candidates = useOwnerCandidates(api, organizationSlug, item.projectId);
  const [picking, setPicking] = useState<'doers' | 'supervisors' | 'watchers' | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  // Phone (Figma `WV2-02` phone): four rows first, then "Show all 15" opens the rest in place.
  const [all, setAll] = useState(false);
  const peopleKey = workItemPeopleKey(organizationSlug, item.id);
  const people = useQuery({
    queryKey: peopleKey,
    queryFn: () => getWorkItemPeople(api, organizationSlug, item.id),
  });
  const labels = useQuery({
    queryKey: ['work-item-labels', organizationSlug, item.id],
    queryFn: () => listItemLabels(api, organizationSlug, item.id),
  });
  const recurrence = useQuery({
    queryKey: ['work-item-recurrence', organizationSlug, item.id],
    queryFn: () => getWorkItemRecurrence(api, organizationSlug, item.id),
  });
  const estimate = useQuery({
    queryKey: ['work-item-estimate', organizationSlug, item.id],
    queryFn: () => getWorkItemEstimate(api, organizationSlug, item.id),
  });
  const links = useQuery({
    queryKey: ['work-item-links', organizationSlug, item.id],
    queryFn: () => listItemLinks(api, organizationSlug, item.id),
  });

  const savePeople = useMutation({
    mutationFn: async ({
      row,
      ids,
    }: {
      row: 'doers' | 'supervisors' | 'watchers';
      ids: readonly string[];
    }) => {
      if (row === 'watchers') {
        const before = people.data?.watcherUserIds ?? [];
        const added = ids.filter((id) => !before.includes(id));
        if (added.length > 0) await addWorkItemWatchers(api, organizationSlug, item.id, added);
        for (const id of before.filter((id) => !ids.includes(id))) {
          await removeWorkItemWatcher(api, organizationSlug, item.id, id);
        }
      } else await setWorkItemPeople(api, organizationSlug, item.id, row, ids);
    },
    onSuccess: () => {
      setPicking(null);
      setFailure(undefined);
      void queries.invalidateQueries({ queryKey: peopleKey });
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      void queries.invalidateQueries({ queryKey: ['work-item', organizationSlug, item.id] });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const nameOf = (id: string) => memberDisplayName(id, directory.members, directory.isPending);
  const doers = people.data?.doerUserIds ?? [];
  const supervisors = people.data?.supervisorUserIds ?? [];
  const watchers = people.data?.watcherUserIds ?? [];
  const add = t('WorkPage.add');

  const faces = (ids: readonly string[]) =>
    ids.length === 0 ? (
      add
    ) : (
      <span className="tm-wk-faces">
        <span className="tm-wk-faces__stack" aria-hidden="true">
          {ids.slice(0, FACES).map((id) => (
            <span key={id} className="tm-wk-face">
              {initialsOf(nameOf(id))}
            </span>
          ))}
        </span>
        {/* One person by full name, several by the first one's first name and "+N" (Figma); the
            full names for a screen reader once the directory has answered, its loading words
            until then (D16: never a former-member label). */}
        <bdi aria-hidden={directory.isPending || ids.length === 1 ? undefined : true}>
          {directory.isPending || ids.length === 1
            ? nameOf(ids[0] as string)
            : nameOf(ids[0] as string).split(/\s+/)[0]}
        </bdi>
        {ids.length > 1 ? (
          // U+200E keeps "+2" reading left to right inside Arabic text (Fable must-fix 6).
          <span className="tm-wk-faces__more" aria-hidden="true">{`‎+${ids.length - 1}`}</span>
        ) : null}
        {directory.isPending || ids.length === 1 ? null : (
          <span className="tm-visually-hidden">{ids.map(nameOf).join(', ')}</span>
        )}
      </span>
    );

  const day = (value: string | null) =>
    value === null ? (
      add
    ) : (
      <span className="tm-wk-inline">
        <CalendarIcon />
        {formatChipDay(dayOf(value), locale)}
      </span>
    );

  const audienceLabel =
    item.audience === 'internal'
      ? t('WorkPage.audienceInternal')
      : item.audience === 'client_action_required'
        ? t('WorkPage.audienceAction')
        : t('WorkPage.audienceFollow');
  const status =
    item.state === 'blocked'
      ? t('WorkPage.statusBlocked')
      : item.state === 'archived'
        ? t('WorkPage.statusArchived')
        : item.state === 'done' && item.completedAt !== null
          ? t('WorkPage.statusCompleted', {
              day: formatChipDay(dayOf(item.completedAt), locale),
            })
          : t('WorkPage.statusActive');
  const repeats = recurrence.data
    ? t(`WorkPage.repeat.${recurrence.data.freq.toLowerCase()}`)
    : t('WorkPage.repeatNo');
  const time =
    estimate.data === undefined
      ? add
      : estimate.data.estimateMinutes === null
        ? formatDuration(estimate.data.actualMinutes, locale)
        : t('WorkPage.timeOf', {
            spent: formatDuration(estimate.data.actualMinutes, locale),
            estimate: formatDuration(estimate.data.estimateMinutes, locale),
          });
  const linkCount = links.data?.length ?? 0;

  return (
    <section
      className="tm-wk-props"
      aria-labelledby="tm-wk-props-title"
      data-testid="work-props"
      data-all={all || undefined}
    >
      <h2 id="tm-wk-props-title" className="tm-wk-props__title">
        {t('WorkPage.details')}
      </h2>

      <PanelRow
        label={t('WorkPage.project')}
        value={
          <span className="tm-wk-inline">
            <FolderIcon />
            <bdi>{projectName || t('WorkPage.project')}</bdi>
          </span>
        }
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeProject')}
        popover={(close) => (
          <ul className="tm-wk-choice" aria-label={t('WorkPage.project')}>
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="tm-wk-menu__item"
                  aria-pressed={project.id === item.projectId}
                  onClick={() => {
                    if (project.id !== item.projectId) onEdit({ projectId: project.id });
                    close();
                  }}
                >
                  <bdi>{project.name}</bdi>
                  {project.id === item.projectId ? <CheckIcon /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        testId="prop-project"
      />

      <div className="tm-wk-prow" data-testid="prop-stage">
        <span className="tm-wk-prow__label">{t('WorkPage.stage')}</span>
        <span className="tm-wk-prow__value tm-wk-prow__value--control">
          <WorkStageControl
            api={api}
            organizationSlug={organizationSlug}
            item={item}
            stages={stages}
            onChanged={onChanged}
            variant="panel"
          />
        </span>
        {/* The stage control is the row's button; the slot draws the same 28 px circle as the
            other rows' icon buttons so the column lines up (Figma `Panel/Row`). */}
        <span className="tm-wk-prow__slot" aria-hidden="true">
          <span className="tm-icon-button tm-icon-button--small tm-wk-prow__glyph">
            <span className="tm-icon-button__glyph">
              <ChevronDownIcon />
            </span>
          </span>
        </span>
      </div>

      <PanelRow
        label={t('WorkPage.doers')}
        value={faces(doers)}
        empty={doers.length === 0}
        icon={<PlusIcon />}
        iconLabel={t('WorkPage.pickDoers')}
        onAction={() => setPicking('doers')}
        testId="prop-doers"
        short
      />
      <PanelRow
        label={t('WorkPage.supervisor')}
        value={faces(supervisors)}
        empty={supervisors.length === 0}
        icon={<InfoIcon />}
        iconLabel={t('WorkPage.pickSupervisor')}
        onAction={() => setPicking('supervisors')}
        testId="prop-supervisor"
        short
      />
      <PanelRow
        label={t('WorkPage.due')}
        value={day(item.dueAt)}
        empty={item.dueAt === null}
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeDue')}
        popover={(close) => (
          <DueDatePicker
            heading={t('DueDatePicker.dueHeading')}
            value={dayOf(item.dueAt)}
            min={dayOf(item.startAt)}
            {...(now === undefined ? {} : { now })}
            onSet={(value) => {
              onEdit({ dueAt: value === null ? null : dayToInstant(value) });
              close();
            }}
            onClose={close}
          />
        )}
        testId="prop-due"
        short
      />
      <PanelRow
        label={t('WorkPage.client')}
        value={
          clientNames.length === 0 || item.audience === 'internal' ? (
            t('WorkPage.audienceInternal')
          ) : (
            <span className="tm-wk-inline">
              <span className="tm-wk-client-dot" aria-hidden="true" />
              <bdi>{clientNames.join(', ')}</bdi>
            </span>
          )
        }
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeClient')}
        popover={audienceEditor}
        testId="prop-client"
        short
      />
      <PanelRow
        label={t('WorkPage.whoSees')}
        value={
          <span className="tm-wk-inline">
            <EyeIcon />
            {audienceLabel}
          </span>
        }
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeWhoSees')}
        popover={audienceEditor}
        testId="prop-audience"
      />
      <PanelRow
        label={t('WorkPage.start')}
        value={day(item.startAt)}
        empty={item.startAt === null}
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeStart')}
        popover={(close) => (
          <DueDatePicker
            heading={t('DueDatePicker.startHeading')}
            value={dayOf(item.startAt)}
            {...(now === undefined ? {} : { now })}
            onSet={(value) => {
              onEdit({ startAt: value === null ? null : dayToInstant(value) });
              close();
            }}
            onClose={close}
          />
        )}
        testId="prop-start"
      />
      <PanelRow
        label={t('WorkPage.labels')}
        value={
          (labels.data?.length ?? 0) === 0 ? (
            add
          ) : (
            <span className="tm-wk-labels">
              {(labels.data ?? []).map((label) => (
                <span key={label.id} className="tm-wk-label">
                  <bdi>{label.name}</bdi>
                </span>
              ))}
            </span>
          )
        }
        empty={(labels.data?.length ?? 0) === 0}
        icon={<PlusIcon />}
        iconLabel={t('WorkPage.pickLabels')}
        popover={() => (
          <LabelPicker
            api={api}
            organizationSlug={organizationSlug}
            workItemId={item.id}
            assigned={(labels.data ?? []).map((label) => label.labelId)}
          />
        )}
        testId="prop-labels"
      />
      <PanelRow
        label={t('WorkPage.repeats')}
        value={repeats}
        icon={<ForwardIcon />}
        iconLabel={t('WorkPage.changeRepeats')}
        popover={() => (
          <WorkItemRecurrencePanel
            organizationSlug={organizationSlug}
            workItemId={item.id}
            api={api}
          />
        )}
        testId="prop-repeats"
      />
      <PanelRow
        label={t('WorkPage.watchers')}
        value={watchers.length === 0 ? add : faces(watchers)}
        empty={watchers.length === 0}
        icon={<PlusIcon />}
        iconLabel={t('WorkPage.pickWatchers')}
        onAction={() => setPicking('watchers')}
        testId="prop-watchers"
      />
      <PanelRow
        label={t('WorkPage.time')}
        value={time}
        icon={<PlayIcon />}
        iconLabel={t('WorkPage.openTime')}
        href={`/${organizationSlug}/work/${item.id}/time-logs`}
        testId="prop-time"
      />
      <PanelRow
        label={t('WorkPage.reminder')}
        value={add}
        empty
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeReminder')}
        popover={() => (
          <WorkItemReminderView
            organizationSlug={organizationSlug}
            workItemId={item.id}
            api={api}
          />
        )}
        testId="prop-reminder"
      />
      <PanelRow
        label={t('WorkPage.links')}
        value={linkCount === 0 ? add : t('WorkPage.linkCount', { count: linkCount })}
        empty={linkCount === 0}
        icon={<PlusIcon />}
        iconLabel={t('WorkPage.openLinks')}
        href={`/${organizationSlug}/work/${item.id}/links`}
        testId="prop-links"
      />
      <PanelRow
        label={t('WorkPage.status')}
        value={status}
        icon={<ChevronDownIcon />}
        iconLabel={t('WorkPage.changeStatus')}
        popover={statusEditor}
        testId="prop-status"
      />

      {all ? null : (
        <button type="button" className="tm-wk-props__all" onClick={() => setAll(true)}>
          {t('WorkPage.showAll', { count: PANEL_ROWS })}
        </button>
      )}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkPage.saveError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {picking !== null ? (
        <PeoplePickerDialog
          title={t(
            picking === 'doers'
              ? 'WorkPeople.pickDoers'
              : picking === 'supervisors'
                ? 'WorkPeople.pickSupervisors'
                : 'WorkPeople.pickWatchers',
          )}
          projectName={projectName}
          candidates={candidates.candidates}
          loading={candidates.loading}
          initial={picking === 'doers' ? doers : picking === 'supervisors' ? supervisors : watchers}
          showLeadHint={picking === 'doers'}
          removeHint={picking === 'watchers'}
          saving={savePeople.isPending || saving}
          onSave={(ids) => savePeople.mutate({ row: picking, ids })}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </section>
  );
}

/** The workspace's labels, ticked when on this work; a press adds or takes one off. */
function LabelPicker({
  api,
  organizationSlug,
  workItemId,
  assigned,
}: {
  api: ApiClient;
  organizationSlug: string;
  workItemId: string;
  assigned: readonly string[];
}) {
  const t = useA6T();
  const queries = useQueryClient();
  const all = useQuery({
    queryKey: ['work-labels', organizationSlug],
    queryFn: () => listWorkLabels(api, organizationSlug),
  });
  const toggle = useMutation({
    mutationFn: async (labelId: string) => {
      if (assigned.includes(labelId)) {
        await removeItemLabel(api, organizationSlug, workItemId, labelId);
      } else {
        await assignItemLabel(api, organizationSlug, workItemId, labelId);
      }
    },
    onSuccess: () =>
      void queries.invalidateQueries({
        queryKey: ['work-item-labels', organizationSlug, workItemId],
      }),
  });
  if ((all.data?.length ?? 0) === 0 && all.isSuccess) {
    return <p className="tm-wk-section__empty">{t('WorkPage.noLabels')}</p>;
  }
  return (
    <ul className="tm-wk-choice" aria-label={t('WorkPage.labels')}>
      {(all.data ?? []).map((label) => (
        <li key={label.id}>
          <button
            type="button"
            className="tm-wk-menu__item"
            aria-pressed={assigned.includes(label.id)}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(label.id)}
          >
            <bdi>{label.name}</bdi>
            {assigned.includes(label.id) ? <CheckIcon /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
