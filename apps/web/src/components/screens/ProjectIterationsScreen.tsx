'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import type { WorkItemState } from '@tmanage/domain';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  burnUpBars,
  completeIteration,
  createIteration,
  getIteration,
  getIterationBurndown,
  listIterations,
  moveIterationItems,
  updateIteration,
} from '../../lib/api/iterations';
import type {
  BurnUpBar,
  IterationDetail,
  IterationPhase,
  IterationSummary,
} from '../../lib/api/iterations';
import { listWorkItems } from '../../lib/api/work-items';
import { useTOr } from '../../lib/i18n/use-t-or';
import { projectWorkTopic, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import { stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import '../../styles/screens/r48-iterations-calendar.css';

/** English copy; the keys reach the catalogs through the R48 L3 i18n fragment. */
export const ITERATIONS_COPY = {
  title: 'Iterations',
  description: 'Plan short work cycles for this project',
  eyebrow: 'Project',
  newIteration: 'New iteration',
  listHeading: 'Project iterations',
  loading: 'Loading iterations',
  loadFailed: 'The iterations could not be loaded',
  emptyTitle: 'No iterations yet',
  emptyBody: 'Plan the first one: give it a name and TManage picks the next free dates.',
  name: 'Name',
  goal: 'Goal',
  goalHint: 'Optional. One line on what this iteration is for.',
  startsOn: 'Starts on',
  endsOn: 'Ends on',
  datesHint: 'Leave both dates empty to take the next free slot.',
  create: 'Create iteration',
  saving: 'Saving',
  cancel: 'Cancel',
  saveFailed: 'The iteration could not be saved',
  phasePlanned: 'Planned',
  phaseActive: 'Active',
  phaseEnded: 'Ended',
  phaseCompleted: 'Completed',
  daysLeft: 'working days left',
  pointsOf: 'of',
  points: 'points',
  items: 'items',
  burnUp: 'Burn-up',
  scope: 'Scope',
  done: 'Done',
  chartLabel: 'Burn-up chart: work done against scope, one bar per working day',
  workHeading: 'Work in this iteration',
  noWork: 'No work in this iteration yet.',
  remove: 'Remove',
  removeFrom: 'Remove from iteration:',
  addWork: 'Add work from this project',
  pickWork: 'Choose work',
  add: 'Add',
  moveFailed: 'The work could not be moved',
  edit: 'Edit',
  saveChanges: 'Save changes',
  moveUnfinishedTo: 'Move unfinished work to',
  backlog: 'Backlog',
  complete: 'Complete iteration',
  completeFailed: 'The iteration could not be completed',
  completedNote: 'This iteration is completed and can no longer change.',
} as const;

type CopyKey = keyof typeof ITERATIONS_COPY;

const PHASE: Record<IterationPhase, { readonly state: CapsuleState; readonly key: CopyKey }> = {
  planned: { state: 'future', key: 'phasePlanned' },
  active: { state: 'current', key: 'phaseActive' },
  ended: { state: 'waiting', key: 'phaseEnded' },
  completed: { state: 'done', key: 'phaseCompleted' },
};

/** The iteration a screen opens on: the active one, else the next planned, else the newest. */
export function defaultIterationId(iterations: readonly IterationSummary[]): string | null {
  const active = iterations.find((i) => i.phase === 'active');
  if (active) return active.id;
  const planned = iterations.find((i) => i.phase === 'planned');
  if (planned) return planned.id;
  return iterations[iterations.length - 1]?.id ?? null;
}

/** Where unfinished work may go on completion: another open iteration of the project. */
export function completionTargets(
  iterations: readonly IterationSummary[],
  currentId: string,
): IterationSummary[] {
  return iterations.filter((i) => i.id !== currentId && i.phase !== 'completed');
}

export interface ProjectIterationsScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

/**
 * **Iterations (53-21)** — Figma 590:33385 (EN) / 590:33526 (AR).
 *
 * A project's light sprints: create one, edit it, move the project's work in and out, watch a
 * burn-up of done against scope, and complete it (unfinished work rolls to another open iteration
 * or back to the backlog in one transaction on the API). Every gate is the API's; the screen shows
 * its refusal in words. It refetches live when the project's work changes (53-01).
 */
export function ProjectIterationsScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectIterationsScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const c = (key: CopyKey) => tOr(`ProjectIterationsScreen.${key}`, ITERATIONS_COPY[key]);
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const listKey = ['iterations', organizationSlug, projectId] as const;

  const list = useQuery({
    queryKey: listKey,
    queryFn: () => listIterations(api, organizationSlug, projectId),
  });
  const iterations = useMemo(() => list.data?.iterations ?? [], [list.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId =
    picked !== null && iterations.some((i) => i.id === picked)
      ? picked
      : defaultIterationId(iterations);
  const [creating, setCreating] = useState(false);

  useWorkLiveRefresh({
    api,
    organizationSlug,
    topics: [projectWorkTopic(projectId)],
    // A suite injects its own client and drives no socket; the live layer is the browser's.
    enabled: client === undefined,
    onChange: () =>
      void queryClient.invalidateQueries({ queryKey: ['iterations', organizationSlug] }),
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['iterations', organizationSlug] });
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={c('title')}
      description={c('description')}
      eyebrow={c('eyebrow')}
      topBar={
        <ProjectTabs
          organizationSlug={organizationSlug}
          projectId={projectId}
          current="iterations"
          end={
            <Button tone="ink" onClick={() => setCreating(true)} disabled={creating}>
              {c('newIteration')}
            </Button>
          }
        />
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            {creating ? (
              <IterationForm
                c={c}
                heading={c('newIteration')}
                submitLabel={c('create')}
                initial={{ name: '', goal: '', startsOn: '', endsOn: '' }}
                datesOptional
                onCancel={() => setCreating(false)}
                onSubmit={async (values) => {
                  const created = await createIteration(api, organizationSlug, projectId, {
                    name: values.name,
                    goal: values.goal === '' ? null : values.goal,
                    ...(values.startsOn !== '' && values.endsOn !== ''
                      ? { startsOn: values.startsOn, endsOn: values.endsOn }
                      : {}),
                  });
                  setCreating(false);
                  setPicked(created.id);
                  await refresh();
                }}
              />
            ) : null}
            <section className="tm-r48-card" aria-labelledby="tm-iter-list">
              <h2 id="tm-iter-list" className="tm-r48-eyebrow">
                {c('listHeading')}
              </h2>
              {list.isPending ? (
                <LoadingRegion label={c('loading')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}
              {list.isError ? (
                <InlineAlert tone="danger" title={c('loadFailed')} live>
                  {describeError(list.error)}
                </InlineAlert>
              ) : null}
              {list.isSuccess && iterations.length === 0 ? (
                <InlineAlert tone="neutral" title={c('emptyTitle')}>
                  {c('emptyBody')}
                </InlineAlert>
              ) : null}
              <ul className="tm-r48-list">
                {iterations.map((iteration) => (
                  <li key={iteration.id}>
                    <button
                      type="button"
                      className="tm-r48-iteration"
                      aria-current={iteration.id === selectedId ? 'true' : undefined}
                      onClick={() => setPicked(iteration.id)}
                    >
                      <span className="tm-r48-head">
                        <strong>{iteration.name}</strong>
                        <StateCapsule state={PHASE[iteration.phase].state}>
                          {c(PHASE[iteration.phase].key)}
                        </StateCapsule>
                      </span>
                      <span className="tm-r48-muted">
                        {iteration.startsOn} – {iteration.endsOn}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className="tm-prj__col">
            {selectedId !== null ? (
              <IterationDetailPanel
                key={selectedId}
                api={api}
                organizationSlug={organizationSlug}
                projectId={projectId}
                iterationId={selectedId}
                iterations={iterations}
                pointsEnabled={list.data?.pointsEnabled ?? false}
                c={c}
                onChanged={refresh}
              />
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

interface FormValues {
  readonly name: string;
  readonly goal: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

function IterationForm({
  c,
  heading,
  submitLabel,
  initial,
  datesOptional = false,
  onSubmit,
  onCancel,
}: {
  c: (key: CopyKey) => string;
  heading: string;
  submitLabel: string;
  initial: FormValues;
  datesOptional?: boolean;
  onSubmit: (values: FormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const describeError = useDescribeApiError();
  const [values, setValues] = useState<FormValues>(initial);
  const save = useMutation({ mutationFn: () => onSubmit(values) });
  const set = (field: keyof FormValues) => (event: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: event.target.value }));
  const datesOk = datesOptional
    ? (values.startsOn === '') === (values.endsOn === '')
    : values.startsOn !== '' && values.endsOn !== '';
  const canSave = values.name.trim() !== '' && datesOk;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSave && !save.isPending) save.mutate();
  }

  return (
    <section className="tm-r48-card" aria-label={heading}>
      <h2 className="tm-r48-eyebrow">{heading}</h2>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <fieldset className="tm-fieldset tm-stack" disabled={save.isPending}>
          <Field
            label={c('name')}
            name="name"
            value={values.name}
            onChange={set('name')}
            required
          />
          <Field
            label={c('goal')}
            name="goal"
            value={values.goal}
            onChange={set('goal')}
            hint={c('goalHint')}
          />
          <Field
            label={c('startsOn')}
            name="startsOn"
            type="date"
            value={values.startsOn}
            onChange={set('startsOn')}
            {...(datesOptional ? { hint: c('datesHint') } : {})}
          />
          <Field
            label={c('endsOn')}
            name="endsOn"
            type="date"
            value={values.endsOn}
            onChange={set('endsOn')}
          />
        </fieldset>
        {save.isError ? (
          <InlineAlert tone="danger" title={c('saveFailed')} live>
            {describeError(save.error)}
          </InlineAlert>
        ) : null}
        <div className="tm-r48-actions">
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={c('saving')}
            disabled={!canSave}
          >
            {submitLabel}
          </Button>
          <Button type="button" tone="outline" onClick={onCancel}>
            {c('cancel')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The burn-up mini chart: one bar per working day, done drawn over scope. */
export function BurnUpChart({ bars, label }: { bars: readonly BurnUpBar[]; label: string }) {
  const max = Math.max(1, ...bars.map((bar) => bar.scope));
  const width = 32;
  const height = 120;
  return (
    <svg
      className="tm-r48-chart"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${Math.max(1, bars.length) * width} ${height}`}
      preserveAspectRatio="none"
    >
      {bars.map((bar, index) => {
        const scopeH = (bar.scope / max) * height;
        const doneH = (Math.min(bar.done, bar.scope) / max) * height;
        return (
          <g key={bar.date}>
            <title>{`${bar.date}: ${bar.done} / ${bar.scope}`}</title>
            <rect
              className="tm-r48-chart__scope"
              x={index * width + 2}
              y={height - scopeH}
              width={width - 4}
              height={scopeH}
              rx={2}
            />
            <rect
              className="tm-r48-chart__done"
              x={index * width + 2}
              y={height - doneH}
              width={width - 4}
              height={doneH}
              rx={2}
            />
          </g>
        );
      })}
    </svg>
  );
}

function IterationDetailPanel({
  api,
  organizationSlug,
  projectId,
  iterationId,
  iterations,
  pointsEnabled,
  c,
  onChanged,
}: {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  iterationId: string;
  iterations: readonly IterationSummary[];
  pointsEnabled: boolean;
  c: (key: CopyKey) => string;
  onChanged: () => Promise<void>;
}) {
  const describeError = useDescribeApiError();
  const detail = useQuery({
    queryKey: ['iterations', organizationSlug, projectId, 'detail', iterationId],
    queryFn: () => getIteration(api, organizationSlug, iterationId),
  });
  const burndown = useQuery({
    queryKey: ['iterations', organizationSlug, projectId, 'burndown', iterationId],
    queryFn: () => getIterationBurndown(api, organizationSlug, iterationId),
  });
  const work = useQuery({
    queryKey: ['iterations', organizationSlug, projectId, 'candidates'],
    queryFn: () => listWorkItems(api, organizationSlug, { projectId, limit: 200 }),
  });
  const [editing, setEditing] = useState(false);
  const [toAdd, setToAdd] = useState('');
  const [target, setTarget] = useState('');

  const move = useMutation({
    mutationFn: (change: { add?: string[]; remove?: string[] }) =>
      moveIterationItems(api, organizationSlug, iterationId, change),
    onSuccess: async () => {
      setToAdd('');
      await onChanged();
    },
  });
  const complete = useMutation({
    mutationFn: () =>
      completeIteration(api, organizationSlug, iterationId, target === '' ? null : target),
    onSuccess: onChanged,
  });

  if (detail.isPending) {
    return (
      <LoadingRegion label={c('loading')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (detail.isError) {
    return (
      <InlineAlert tone="danger" title={c('loadFailed')} live>
        {describeError(detail.error)}
      </InlineAlert>
    );
  }
  const it: IterationDetail = detail.data;
  const closed = it.phase === 'completed';
  const inIteration = new Set(it.items.map((item) => item.id));
  const candidates = (work.data ?? []).filter(
    (item) => !inIteration.has(item.id) && item.state !== 'done' && item.state !== 'archived',
  );
  const targets = completionTargets(iterations, it.id);
  const bars = burnUpBars(burndown.data?.points ?? [], pointsEnabled);

  return (
    <div className="tm-stack tm-stack--loose">
      {editing ? (
        <IterationForm
          c={c}
          heading={c('edit')}
          submitLabel={c('saveChanges')}
          initial={{ name: it.name, goal: it.goal ?? '', startsOn: it.startsOn, endsOn: it.endsOn }}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await updateIteration(api, organizationSlug, it.id, {
              name: values.name,
              goal: values.goal === '' ? null : values.goal,
              startsOn: values.startsOn,
              endsOn: values.endsOn,
              expectedVersion: it.version,
            });
            setEditing(false);
            await onChanged();
          }}
        />
      ) : null}
      <section className="tm-r48-card" aria-labelledby="tm-iter-summary">
        <div className="tm-r48-head">
          <h2 id="tm-iter-summary">{it.name}</h2>
          <StateCapsule state={PHASE[it.phase].state}>{c(PHASE[it.phase].key)}</StateCapsule>
        </div>
        <p className="tm-r48-muted">
          {it.startsOn} – {it.endsOn}
          {closed ? '' : ` · ${it.daysLeft} ${c('daysLeft')}`}
          {pointsEnabled
            ? ` · ${it.donePoints} ${c('pointsOf')} ${it.committedPoints} ${c('points')}`
            : ` · ${it.itemCount} ${c('items')}`}
        </p>
        {it.goal ? <p>{it.goal}</p> : null}
        <h3 className="tm-r48-eyebrow">{c('burnUp')}</h3>
        <BurnUpChart bars={bars} label={c('chartLabel')} />
        <ul className="tm-r48-legend">
          <li>
            <span className="tm-r48-swatch tm-r48-swatch--scope" aria-hidden="true" />
            {c('scope')}
          </li>
          <li>
            <span className="tm-r48-swatch tm-r48-swatch--done" aria-hidden="true" />
            {c('done')}
          </li>
        </ul>
      </section>

      <section className="tm-r48-card" aria-labelledby="tm-iter-work">
        <h3 id="tm-iter-work" className="tm-r48-eyebrow">
          {c('workHeading')}
        </h3>
        {it.items.length === 0 ? <p className="tm-r48-muted">{c('noWork')}</p> : null}
        <ul className="tm-r48-list">
          {it.items.map((item) => (
            <li key={item.id} className="tm-r48-row">
              <span className="tm-r48-row__title">{item.title}</span>
              <StateCapsule state={stateCapsule(item.state as WorkItemState)}>
                {stateLabel(item.state as WorkItemState)}
              </StateCapsule>
              {pointsEnabled && item.points !== null ? (
                <span className="tm-r48-muted">
                  {item.points} {c('points')}
                </span>
              ) : null}
              {closed ? null : (
                <Button
                  tone="text"
                  size="compact"
                  aria-label={`${c('removeFrom')} ${item.title}`}
                  disabled={move.isPending}
                  onClick={() => move.mutate({ remove: [item.id] })}
                >
                  {c('remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {move.isError ? (
          <InlineAlert tone="danger" title={c('moveFailed')} live>
            {describeError(move.error)}
          </InlineAlert>
        ) : null}
        {closed ? null : (
          <div className="tm-r48-actions">
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-iter-add">
                {c('addWork')}
              </label>
              <select
                id="tm-iter-add"
                className="tm-field__control"
                value={toAdd}
                onChange={(event) => setToAdd(event.target.value)}
              >
                <option value="">{c('pickWork')}</option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            <Button
              tone="outline"
              disabled={toAdd === '' || move.isPending}
              onClick={() => move.mutate({ add: [toAdd] })}
            >
              {c('add')}
            </Button>
          </div>
        )}
      </section>

      {closed ? (
        <InlineAlert tone="neutral" title={c('phaseCompleted')}>
          {c('completedNote')}
        </InlineAlert>
      ) : (
        <div className="tm-r48-actions">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-iter-target">
              {c('moveUnfinishedTo')}
            </label>
            <select
              id="tm-iter-target"
              className="tm-field__control"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">{c('backlog')}</option>
              {targets.map((iteration) => (
                <option key={iteration.id} value={iteration.id}>
                  {iteration.name}
                </option>
              ))}
            </select>
          </div>
          <Button tone="outline" onClick={() => setEditing(true)} disabled={editing}>
            {c('edit')}
          </Button>
          <Button
            tone="ink"
            loading={complete.isPending}
            loadingLabel={c('saving')}
            onClick={() => complete.mutate()}
          >
            {c('complete')}
          </Button>
        </div>
      )}
      {complete.isError ? (
        <InlineAlert tone="danger" title={c('completeFailed')} live>
          {describeError(complete.error)}
        </InlineAlert>
      ) : null}
    </div>
  );
}
