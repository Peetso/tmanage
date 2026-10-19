'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Button,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { getProject } from '../../lib/api/projects';
import {
  createProjectMilestone,
  listProjectMilestones,
  postProjectUpdate,
} from '../../lib/api/portal';
import type { MilestoneStatus, ProjectMilestone } from '../../lib/api/portal';
import { listProjectShares } from '../../lib/api/clients';
import { listWorkItems, MAX_WORK_ITEM_PAGE } from '../../lib/api/work-items';
import type { WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import {
  audienceLabel,
  formatDay,
  formatInstant,
  isClientFacing,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useHydrated } from '../../lib/use-hydrated';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectOverviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
  /** Injected in tests so the overdue count can be exercised against a fixed day. */
  now?: Date;
}

/**
 * **TM-03 Project overview.**
 *
 * `22-SCREEN-BY-SCREEN` §4: "Header: project, client/internal badge, health explanation,
 * owner, committed/forecast dates. Sections: milestones, next actions, blockers, latest
 * internal pulse, client-publication state."
 *
 * ## "Health explanation" is not a health score
 *
 * The specification asks for the *explanation*, and this screen gives only that: how many
 * items are blocked, how many are past their due date, how much is done. There is no letter
 * grade, no traffic light and no percentage — because a number would be an opinion the data
 * model has not been asked to hold, and once a colour appears next to a project name people
 * manage the colour. The counts below are each a link into the work list filtered to exactly
 * the items they counted, so the explanation is checkable rather than assertable.
 *
 * A scored indicator belongs with `HOME-001`'s ranking and explanation, the nearest thing
 * `28-SPRINT-TICKETS` schedules, and it will need a stated formula before it can be drawn. Until then the honest thing is arithmetic anybody can repeat.
 *
 * ## Committed and forecast stay two dates
 *
 * `PROJ-001` deliberately keeps `committed_at` and `forecast_at` apart, and this is the screen
 * where the distinction earns its keep: a forecast that slips is normal and a commitment that
 * slips is a conversation with a client. Collapsing them into "due" here would undo the whole
 * point of storing two columns.
 */
export function ProjectOverviewScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
  now = new Date(),
}: ProjectOverviewScreenProps) {
  const api = client ?? browserApiClient();

  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });

  useRecordRecentItem({
    organizationSlug,
    objectType: 'project',
    objectId: projectId,
    enabled: project.isSuccess,
    client,
  });

  const workItems = useQuery({
    queryKey: workItemKeys.project(organizationSlug, projectId),
    queryFn: () => listWorkItems(api, organizationSlug, { projectId, limit: MAX_WORK_ITEM_PAGE }),
  });

  /*
   * Whether this project is shared with a client — the fact behind §4's "client/internal
   * badge". The endpoint sits behind `project.manage`, so a reader without that capability
   * gets a 403 here; for them no badge is drawn at all, because a badge this screen cannot
   * verify would be the guess the old unconditional "Internal" was.
   */
  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, projectId],
    queryFn: () => listProjectShares(api, organizationSlug, projectId),
  });

  // D16. One directory for the owner line, the same list `WorkItemDetailScreen`'s picker reads,
  // so the name shown here and the name chosen there can never come from two different answers.
  const directory = useMembers(api, organizationSlug);

  const items = workItems.data ?? [];
  const blocked = items.filter((item) => item.state === 'blocked');
  const nextActions = items
    .filter((item) => item.state === 'ready' || item.state === 'in_progress')
    .slice()
    .sort(byDueDate);
  const overdue = items.filter((item) => isOverdue(item, now));
  const done = items.filter((item) => item.state === 'done' || item.state === 'archived');
  const clientFacing = items.filter((item) => isClientFacing(item.audience));

  // The same query (and cache entry) `MilestoneComposer` reads, so the pulse track and the list
  // under the composer can never disagree.
  const milestones = useQuery({
    queryKey: ['project-milestones', organizationSlug, projectId],
    queryFn: () => listProjectMilestones(api, organizationSlug, projectId),
  });
  const track = pulseTrack(Array.isArray(milestones.data) ? milestones.data : []);
  const currentMilestone = track.find((entry) => entry.state === 'current');

  const nameOf = (userId: string | null) =>
    memberDisplayName(userId, directory.members, directory.isPending);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={project.data?.name ?? 'Project'}
      eyebrow="Project"
      description="Progress is measured by milestone evidence, not by counting finished tasks."
      topBar={
        <ProjectTabs
          organizationSlug={organizationSlug}
          projectId={projectId}
          current="overview"
          end={
            <>
              <Link
                className="tm-button tm-button--outline tm-button--accessible"
                href={`/${organizationSlug}/work?project=${encodeURIComponent(projectId)}`}
              >
                Update work
              </Link>
              <a
                className="tm-button tm-button--ink tm-button--accessible"
                href="#tm-project-update-composer"
              >
                <span className="tm-button__orb" aria-hidden="true">
                  ✎
                </span>
                Post update
              </a>
            </>
          }
        />
      }
      headerAside={
        workItems.data ? (
          <div className="tm-prj-metrics">
            {currentMilestone?.milestone.dueOn ? (
              <MilestoneMetric milestone={currentMilestone.milestone} now={now} />
            ) : null}
            <div className="tm-metric">
              <div className="tm-metric__value-row">
                <span className="tm-metric__value">{pad(blocked.length)}</span>
                <span
                  className={`tm-pill ${blocked.length > 0 ? 'tm-pill--danger' : 'tm-pill--current'}`}
                >
                  {blocked.length > 0 ? 'blocked' : 'clear'}
                </span>
              </div>
              <span className="tm-metric__label">items blocked</span>
              <span className="tm-metric__source">
                {done.length} of {items.length} finished
              </span>
            </div>
            <div className="tm-metric">
              <div className="tm-metric__value-row">
                <span className="tm-metric__value">{pad(overdue.length)}</span>
                <span className={`tm-pill ${overdue.length > 0 ? 'tm-pill--warning' : ''}`}>
                  {overdue.length > 0 ? 'late' : 'on time'}
                </span>
              </div>
              <span className="tm-metric__label">past their due date</span>
              <span className="tm-metric__source">across {items.length} work items</span>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="tm-prj">
        {project.isError || workItems.isError ? (
          <InlineAlert tone="danger" title="Could not load this project" live>
            {describe(project.error ?? workItems.error)}
          </InlineAlert>
        ) : null}

        {project.isPending ? (
          <LoadingRegion label="Loading this project.">
            <Skeleton height="56px" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {project.data ? (
          <section className="tm-prj-strip" aria-labelledby="tm-project-header">
            <div className="tm-prj-strip__head">
              <h2 id="tm-project-header" className="tm-prj-eyebrow">
                This project
              </h2>
              {/*
                The badge states what `project_clients` actually holds, or nothing. "Internal"
                is asserted only after the shares endpoint answered with an empty list;
                "Shared with a client" only after it answered with a non-empty one. While the
                query is in flight — or refused, the endpoint sits behind `project.manage` —
                there is no badge.
              */}
              {shares.data !== undefined ? (
                shares.data.length > 0 ? (
                  <Badge tone="client">Shared with a client</Badge>
                ) : (
                  <Badge>Internal</Badge>
                )
              ) : null}
              <StateCapsule state={project.data.status === 'active' ? 'current' : 'archived'}>
                {project.data.status === 'active' ? 'Active' : project.data.status}
              </StateCapsule>
              {/* D16: the owner by name; committed and forecast stay two dates (PROJ-001). */}
              <dl className="tm-prj-strip__facts">
                <div>
                  <dt>Owner</dt>
                  <dd>{nameOf(project.data.ownerUserId)}</dd>
                </div>
                <div>
                  <dt>Committed</dt>
                  <dd>
                    {project.data.committedAt === null
                      ? 'Nothing committed yet'
                      : formatDay(project.data.committedAt)}
                  </dd>
                </div>
                <div>
                  <dt>Forecast</dt>
                  <dd>
                    {project.data.forecastAt === null
                      ? 'No forecast yet'
                      : formatDay(project.data.forecastAt)}
                  </dd>
                </div>
              </dl>
            </div>

            {track.length === 0 ? (
              <ol
                className="tm-pulse-track tm-pulse-track--bare tm-prj-track"
                aria-label="Milestones"
              >
                <li data-state="uncertain">
                  <span className="tm-prj-track__title">No milestones yet</span>
                  <span className="tm-prj-track__meta">add the first one below</span>
                </li>
              </ol>
            ) : (
              <ol
                className="tm-pulse-track tm-pulse-track--bare tm-prj-track"
                aria-label="Milestones"
              >
                {track.map(({ milestone, state }) => (
                  <li key={milestone.id} data-state={state}>
                    {state === 'current' ? (
                      <>
                        <span className="tm-stack tm-stack--tight">
                          <span className="tm-prj-track__kicker">Current</span>
                          <span className="tm-prj-track__title">{milestone.title}</span>
                        </span>
                        <span className="tm-pulse-track__meta">
                          {milestone.dueOn === null
                            ? 'no date'
                            : `due ${formatDay(milestone.dueOn)}`}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="tm-prj-track__title">
                          {state === 'done' ? '✓ ' : ''}
                          {milestone.title}
                        </span>
                        <span className="tm-prj-track__meta">
                          {milestone.status === 'missed'
                            ? 'missed'
                            : milestone.dueOn === null
                              ? 'no date'
                              : formatDay(milestone.dueOn)}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}

        <div className="tm-prj__grid">
          <div className="tm-prj__col">
            <section className="tm-stack" aria-labelledby="tm-project-blockers">
              <div className="tm-section-head">
                <h2 id="tm-project-blockers" className="tm-section-head__title">
                  Blockers
                </h2>
                <span className="tm-section-head__meta">
                  {blocked.length === 1 ? '1 item' : `${blocked.length} items`}
                </span>
              </div>
              {blocked.length === 0 ? (
                <div className="tm-card tm-card--empty tm-prj-card">
                  <p className="tm-card__meta">Nothing is blocked.</p>
                </div>
              ) : (
                <ul className="tm-card-grid">
                  {blocked.map((item) => (
                    <li key={item.id} className="tm-card tm-prj-card">
                      <span className="tm-card__eyebrow">
                        Blocked · {item.dueAt === null ? 'no date' : `due ${formatDay(item.dueAt)}`}
                      </span>
                      <h3 className="tm-prj-card__title">
                        <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                      </h3>
                      <span className="tm-prj-flag">
                        {stateLabel(item.state)} · {nameOf(item.ownerUserId)}
                      </span>
                      {isOverdue(item, now) ? (
                        <StateCapsule state="blocked">Overdue</StateCapsule>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <WorkSection
              id="tm-project-next"
              title="Next actions"
              empty="Nothing is ready or in progress. Everything is either in the backlog or finished."
              items={nextActions}
              organizationSlug={organizationSlug}
              now={now}
              nameOf={nameOf}
              workHref={`/${organizationSlug}/work?project=${encodeURIComponent(projectId)}`}
            />

            <MilestoneComposer
              api={api}
              organizationSlug={organizationSlug}
              projectId={projectId}
            />
          </div>

          <div className="tm-prj__col">
            <section
              className="tm-card tm-card--ink tm-prj-client"
              aria-labelledby="tm-project-client"
            >
              <h2 id="tm-project-client" className="tm-prj-eyebrow">
                What the client can see
              </h2>
              <div className="tm-prj-client__figure">
                <span className="tm-prj-client__value">{clientFacing.length}</span>
                <span>
                  {clientFacing.length === 1
                    ? 'item is visible in the client portal'
                    : 'items are visible in the client portal'}
                </span>
              </div>
              {clientFacing.length > 0 ? (
                <ul className="tm-prj-client__list">
                  {clientFacing.map((item) => (
                    <li key={item.id}>
                      <span className="tm-prj-client__ring" aria-hidden="true">
                        CL
                      </span>
                      <span className="tm-stack tm-stack--tight">
                        <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                        <span className="tm-meta-mono">
                          {audienceLabel(item.audience)} · {stateLabel(item.state)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <hr className="tm-prj-client__rule" />
              <p className="tm-prj-client__prose">
                {clientFacing.length === 0
                  ? 'Nothing in this project is shared with a client. Every item is internal, which is what a new item starts as.'
                  : 'This is what a client member reading the portal right now would see. Internal work, risks and comments stay internal.'}
              </p>
            </section>

            <section className="tm-card tm-prj-card" aria-labelledby="tm-project-health">
              <h2 id="tm-project-health" className="tm-section-head__title">
                How it is going
              </h2>
              {workItems.isPending ? (
                <LoadingRegion label="Counting the work.">
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : (
                <>
                  <p className="tm-prose">
                    {healthSentence(items.length, blocked.length, overdue.length)}
                  </p>
                  <p className="tm-card__meta">
                    These are counts, not a score. Every one of them is a number you can check in
                    the work list.
                  </p>
                  {items.length >= MAX_WORK_ITEM_PAGE ? (
                    <InlineAlert tone="warning" title="These counts are a page, not a total">
                      This project has at least {MAX_WORK_ITEM_PAGE} work items, which is a full
                      page. The counts above describe what was loaded, not the whole project.
                    </InlineAlert>
                  ) : null}
                </>
              )}
            </section>

            <UpdateComposer api={api} organizationSlug={organizationSlug} projectId={projectId} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

type TrackState = 'done' | 'current' | 'future' | 'risk' | 'uncertain';

/**
 * The milestone pulse track: met is confirmed history (ink), the first planned milestone is now
 * (lime), a missed one is a risk, and the rest are future; an undated future one is uncertain.
 */
function pulseTrack(
  rows: readonly ProjectMilestone[],
): readonly { milestone: ProjectMilestone; state: TrackState }[] {
  const ordered = rows.slice().sort((left, right) => {
    if (left.dueOn === right.dueOn) return 0;
    if (left.dueOn === null) return 1;
    if (right.dueOn === null) return -1;
    return left.dueOn < right.dueOn ? -1 : 1;
  });
  let currentTaken = false;
  return ordered.map((milestone) => {
    if (milestone.status === 'met') return { milestone, state: 'done' as const };
    if (milestone.status === 'missed') return { milestone, state: 'risk' as const };
    if (!currentTaken) {
      currentTaken = true;
      return { milestone, state: 'current' as const };
    }
    return { milestone, state: milestone.dueOn === null ? 'uncertain' : 'future' } as const;
  });
}

function MilestoneMetric({ milestone, now }: { milestone: ProjectMilestone; now: Date }) {
  const due =
    milestone.dueOn === null ? null : Date.parse(`${milestone.dueOn.slice(0, 10)}T00:00:00Z`);
  if (due === null || Number.isNaN(due)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((due - today) / 86_400_000);
  return (
    <div className="tm-metric">
      <div className="tm-metric__value-row">
        <span className="tm-metric__value">{pad(Math.abs(days))}</span>
        <span className={`tm-pill ${days < 0 ? 'tm-pill--warning' : 'tm-pill--current'}`}>
          {days < 0 ? 'late' : 'next'}
        </span>
      </div>
      <span className="tm-metric__label">
        {days < 0 ? 'days past' : 'days to'} {milestone.title}
      </span>
      <span className="tm-metric__source">milestone due {formatDay(milestone.dueOn)}</span>
    </div>
  );
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

interface WorkSectionProps {
  id: string;
  title: string;
  empty: string;
  items: readonly WorkItemSummary[];
  organizationSlug: string;
  now: Date;
  nameOf: (userId: string | null) => string;
  workHref: string;
}

/**
 * PRJ-01 "What decides the milestone" + "Open commitments": the first next action is the one lime
 * card on the screen; the rest are rows with the owner's disc, state and due date.
 */
function WorkSection({
  id,
  title,
  empty,
  items,
  organizationSlug,
  now,
  nameOf,
  workHref,
}: WorkSectionProps) {
  const [lead, ...rest] = items;
  return (
    <section className="tm-stack" aria-labelledby={id}>
      <div className="tm-section-head">
        <h2 id={id} className="tm-section-head__title">
          {title}
        </h2>
        <span className="tm-section-head__meta">
          {items.length === 1 ? '1 item' : `${items.length} items`}
        </span>
        <span className="tm-section-head__end">
          <Link className="tm-meta-mono" href={workHref}>
            Open all
          </Link>
        </span>
      </div>
      {lead === undefined ? (
        <div className="tm-card tm-card--empty tm-prj-card">
          <p className="tm-card__meta">{empty}</p>
        </div>
      ) : (
        <>
          <article className="tm-card tm-card--lime tm-prj-card">
            <span className="tm-card__eyebrow">Next · {audienceLabel(lead.audience)}</span>
            <h3 className="tm-prj-card__title">
              <Link href={`/${organizationSlug}/work/${lead.id}`}>{lead.title}</Link>
            </h3>
            <span className="tm-prj-capsule">
              <span className="tm-prj-capsule__orb" aria-hidden="true">
                !
              </span>
              {stateLabel(lead.state)} · {nameOf(lead.ownerUserId)}
            </span>
            <span className="tm-meta-mono">
              {lead.dueAt === null ? 'no due date' : `due ${formatInstant(lead.dueAt)}`}
              {isOverdue(lead, now) ? ' · overdue' : ''}
            </span>
          </article>
          {rest.length > 0 ? (
            <ul className="tm-row-list tm-prj-rows">
              {rest.map((item) => (
                <li key={item.id}>
                  <Avatar name={nameOf(item.ownerUserId)} size="compact" decorative />
                  <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                  <span className="tm-row-list__end">
                    <StateCapsule state={stateCapsule(item.state)}>
                      {stateLabel(item.state)}
                    </StateCapsule>
                    {isOverdue(item, now) ? (
                      <StateCapsule state="blocked">Overdue</StateCapsule>
                    ) : null}
                    <span className="tm-meta-mono">{formatInstant(item.dueAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

interface ComposerProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
}

/** `project_milestones.title` is VARCHAR(300). */
const MAX_MILESTONE_TITLE_LENGTH = 300;

const MILESTONE_STATUS_OPTIONS: readonly { value: MilestoneStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'met', label: 'Met' },
  { value: 'missed', label: 'Missed' },
];

function milestoneCapsuleState(status: MilestoneStatus): 'done' | 'blocked' | 'future' {
  if (status === 'met') return 'done';
  if (status === 'missed') return 'blocked';
  return 'future';
}

/**
 * SEC / Portal milestones (x139) — the internal compose surface and list.
 *
 * The write is behind `project.manage` (the API refuses anyone else) and posts to the internal
 * `projects` path, never `/portal`. "Publish to the client now" is checked by default: a milestone
 * created here is meant to reach the client, and leaving it unchecked keeps it a draft the client
 * cannot see (`published = false`). Editing or unpublishing is a later slice, so there is no way to
 * change that after creating yet — said in the hint rather than left implicit.
 *
 * The list shows the full internal record (including drafts, which the client never sees); on a
 * successful create the client-facing portal query is invalidated so an open portal tab picks the
 * new milestone up, and the internal list refetches.
 */
function MilestoneComposer({ api, organizationSlug, projectId }: ComposerProps) {
  const queries = useQueryClient();
  // Controls ship disabled until React hydrates, so nothing typed into the server HTML is wiped.
  const hydrated = useHydrated();
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [status, setStatus] = useState<MilestoneStatus>('planned');
  const [publishNow, setPublishNow] = useState(true);

  const milestones = useQuery({
    queryKey: ['project-milestones', organizationSlug, projectId],
    queryFn: () => listProjectMilestones(api, organizationSlug, projectId),
  });

  const create = useMutation({
    mutationFn: (vars: {
      title: string;
      dueOn: string | null;
      status: MilestoneStatus;
      published: boolean;
    }) => createProjectMilestone(api, organizationSlug, projectId, vars),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['project-milestones', organizationSlug, projectId],
      });
      void queries.invalidateQueries({
        queryKey: ['portal-milestones', organizationSlug, projectId],
      });
      setTitle('');
      setDueOn('');
      setStatus('planned');
      setPublishNow(true);
    },
  });

  const canCreate = title.trim() !== '' && !create.isPending;
  const rows: readonly ProjectMilestone[] = milestones.data ?? [];

  return (
    <section className="tm-card tm-prj-card" aria-labelledby="tm-project-milestones">
      <h2 id="tm-project-milestones" className="tm-section-head__title">
        Milestones
      </h2>

      {milestones.isError ? (
        <InlineAlert tone="danger" title="Could not load milestones" live>
          {describe(milestones.error)}
        </InlineAlert>
      ) : rows.length === 0 ? (
        <p className="tm-prose">No milestones yet. Add the first below.</p>
      ) : (
        <ol className="tm-prj-milestones">
          {rows.map((milestone) => (
            <li key={milestone.id}>
              <h3 className="tm-prj-milestones__title">{milestone.title}</h3>
              <span className="tm-meta-mono">
                {milestone.dueOn === null
                  ? 'No date committed'
                  : `Due ${formatDay(milestone.dueOn)}`}
              </span>
              <StateCapsule state={milestoneCapsuleState(milestone.status)} className="tm-push-end">
                {milestone.status}
              </StateCapsule>
              {!milestone.published ? <StateCapsule state="neutral">Draft</StateCapsule> : null}
            </li>
          ))}
        </ol>
      )}

      <form
        className="tm-prj-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate)
            create.mutate({
              title: title.trim(),
              dueOn: dueOn === '' ? null : dueOn,
              status,
              published: publishNow,
            });
        }}
      >
        <div className="tm-prj-form__row">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-project-milestone-title">
              Title
            </label>
            <input
              id="tm-project-milestone-title"
              className="tm-field__control"
              value={title}
              maxLength={MAX_MILESTONE_TITLE_LENGTH}
              required
              disabled={!hydrated}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-project-milestone-due">
              Target date
            </label>
            <input
              id="tm-project-milestone-due"
              className="tm-field__control"
              type="date"
              value={dueOn}
              disabled={!hydrated}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-project-milestone-status">
              Status
            </label>
            <select
              id="tm-project-milestone-status"
              className="tm-field__control"
              value={status}
              disabled={!hydrated}
              onChange={(event) => setStatus(event.target.value as MilestoneStatus)}
            >
              {MILESTONE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="tm-choice tm-choice--inline">
          <input
            className="tm-choice__input"
            type="checkbox"
            checked={publishNow}
            disabled={!hydrated}
            onChange={(event) => setPublishNow(event.target.checked)}
          />
          <span className="tm-choice__name">Publish to the client now</span>
        </label>
        <span className="tm-field__hint">
          A published milestone is visible in the client portal straight away. Leave this unchecked
          to keep it a draft only your studio can see. Add it the way you mean it: a milestone
          cannot be edited or unpublished afterwards.
        </span>

        {create.isError ? (
          <InlineAlert tone="danger" title="Could not add the milestone" live>
            {describe(create.error)}
          </InlineAlert>
        ) : null}
        {create.isSuccess ? (
          <InlineAlert tone="success" title="Milestone added" live>
            {/* Report what was actually added, not the live form state: `onSuccess` resets
                `publishNow` to true, so reading it here would call a draft "live". */}
            {create.variables.published
              ? 'Your milestone is live in the client portal.'
              : 'Your draft is saved. It is not visible to the client.'}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={!canCreate}
            loading={create.isPending}
            loadingLabel="Adding"
          >
            Add milestone
          </Button>
        </div>
      </form>
    </section>
  );
}

interface UpdateComposerProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
}

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

/**
 * CL-03's internal compose surface (the client-portal updates timeline) — a manager posting an update to the client's portal
 * timeline.
 *
 * The write is behind `project.manage` (the API refuses anyone else), and it posts to the
 * internal `projects` path, never `/portal`. "Publish to the client now" is checked by default:
 * an update posted here is meant to reach the client, and leaving it unchecked keeps it a draft
 * the client cannot see (`published = false`). The publish/unpublish lifecycle is a later slice,
 * so there is no way to change that after posting yet — said in the hint rather than left implicit.
 *
 * On success the client-facing portal-updates query is invalidated so a portal tab already open
 * picks the new update up, and the form clears.
 */
function UpdateComposer({ api, organizationSlug, projectId }: UpdateComposerProps) {
  const queries = useQueryClient();
  // Controls ship disabled until React hydrates, so nothing typed into the server HTML is wiped.
  const hydrated = useHydrated();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [publishNow, setPublishNow] = useState(true);

  const post = useMutation({
    mutationFn: (vars: { title: string; body: string; published: boolean }) =>
      postProjectUpdate(api, organizationSlug, projectId, vars),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['portal-updates', organizationSlug, projectId] });
      setTitle('');
      setBody('');
      setPublishNow(true);
    },
  });

  const canPost = title.trim() !== '' && body.trim() !== '' && !post.isPending;

  return (
    <section
      className="tm-card tm-prj-card"
      id="tm-project-update-composer-card"
      aria-labelledby="tm-project-update-composer"
    >
      <h2 id="tm-project-update-composer" className="tm-section-head__title" tabIndex={-1}>
        Post an update
      </h2>

      <form
        className="tm-prj-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canPost)
            post.mutate({ title: title.trim(), body: body.trim(), published: publishNow });
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-project-update-title">
            Title
          </label>
          <input
            id="tm-project-update-title"
            className="tm-field__control"
            value={title}
            maxLength={MAX_UPDATE_TITLE_LENGTH}
            required
            disabled={!hydrated}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-project-update-body">
            Update
          </label>
          <textarea
            id="tm-project-update-body"
            className="tm-field__control"
            value={body}
            rows={4}
            required
            disabled={!hydrated}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        <label className="tm-choice tm-choice--inline">
          <input
            className="tm-choice__input"
            type="checkbox"
            checked={publishNow}
            disabled={!hydrated}
            onChange={(event) => setPublishNow(event.target.checked)}
          />
          <span className="tm-choice__name">Publish to the client now</span>
        </label>
        <span className="tm-field__hint">
          A published update is visible in the client portal straight away. Leave this unchecked to
          keep it a draft only your studio can see. Post it the way you mean it: an update cannot be
          edited or unpublished afterwards.
        </span>

        {post.isError ? (
          <InlineAlert tone="danger" title="Could not post the update" live>
            {describe(post.error)}
          </InlineAlert>
        ) : null}
        {post.isSuccess ? (
          <InlineAlert tone="success" title="Update posted" live>
            {/* The banner must report what was actually posted, not the live form state: the form
                (including `publishNow`) resets to its defaults on success, so deriving the copy from
                `publishNow` here would always say "live" — even for a draft. `post.variables` holds
                the values the last `mutate` carried and persists through the success state. */}
            {post.variables.published
              ? 'Your update is live in the client portal.'
              : 'Your draft is saved. It is not visible to the client.'}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={!canPost}
            loading={post.isPending}
            loadingLabel="Posting"
          >
            Post update
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * The explanation, in one sentence, built out of the same counts printed beneath it.
 *
 * Written as a statement of fact rather than a judgement. "Two items are blocked" is something
 * anyone can verify; "this project is at risk" is a claim that would need a definition of risk
 * this system has not agreed on.
 */
function healthSentence(total: number, blocked: number, overdue: number): string {
  if (total === 0) return 'There is no work in this project yet, so there is nothing to report.';

  const parts: string[] = [];
  if (blocked > 0)
    parts.push(blocked === 1 ? 'one item is blocked' : `${blocked} items are blocked`);
  if (overdue > 0) {
    parts.push(
      overdue === 1 ? 'one item is past its due date' : `${overdue} items are past their due date`,
    );
  }

  if (parts.length === 0) {
    return 'Nothing is blocked and nothing is past its due date.';
  }
  return `${capitalise(parts.join(', and '))}.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Undated items sort last: a due date is information, and its absence is not urgency. */
function byDueDate(left: WorkItemSummary, right: WorkItemSummary): number {
  if (left.dueAt === right.dueAt) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt < right.dueAt ? -1 : 1;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
