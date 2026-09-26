'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { getProject } from '../../lib/api/projects';
import { createProjectMilestone, listProjectMilestones, postProjectUpdate } from '../../lib/api/portal';
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={project.data?.name ?? 'Project'}
      description="Where this project stands, and what it is waiting on."
      actions={
        <Link
          className="tm-button tm-button--ink tm-button--accessible"
          href={`/${organizationSlug}/work?project=${encodeURIComponent(projectId)}`}
        >
          Update work
        </Link>
      }
    >
      {project.isError || workItems.isError ? (
        <InlineAlert tone="danger" title="Could not load this project" live>
          {describe(project.error ?? workItems.error)}
        </InlineAlert>
      ) : null}

      {project.isPending ? (
        <LoadingRegion label="Loading this project.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {project.data ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-project-header">
          <h2 id="tm-project-header" className="tm-eyebrow">
            This project
          </h2>
          <div className="tm-row tm-row--wrap">
            {/*
              The badge states what `project_clients` actually holds, or nothing. "Internal"
              is asserted only after the shares endpoint answered with an empty list;
              "Shared with a client" only after it answered with a non-empty one. While the
              query is in flight — or refused, the endpoint sits behind `project.manage` —
              there is no badge, because the unconditional "Internal" this replaces was
              wrong for every shared project from the day CLIENT-001 landed.
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
          </div>

          <dl className="tm-detail-list">
            <div className="tm-detail-list__pair">
              <dt>Owner</dt>
              {/*
                D16: who is accountable, by name. `memberDisplayName` reads `null` as
                "Unassigned", a name when the directory holds the id, the loading label while it
                is in flight, and a stable "Former or hidden member" label for an id it does not.
              */}
              <dd>
                {memberDisplayName(
                  project.data.ownerUserId,
                  directory.members,
                  directory.isPending,
                )}
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>Committed</dt>
              <dd>
                {project.data.committedAt === null
                  ? 'Nothing committed yet'
                  : formatDay(project.data.committedAt)}
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>Forecast</dt>
              <dd>
                {project.data.forecastAt === null
                  ? 'No forecast yet'
                  : formatDay(project.data.forecastAt)}
              </dd>
            </div>
          </dl>

          <p className="tm-prose">
            A <strong>commitment</strong> is a date the client has been given. A{' '}
            <strong>forecast</strong> is the team’s current estimate. They are kept apart on
            purpose: a forecast that slips is ordinary, and a commitment that slips is a
            conversation.
          </p>
        </section>
      ) : null}

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-project-health">
        <h2 id="tm-project-health" className="tm-eyebrow">
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
            <dl className="tm-detail-list">
              <div className="tm-detail-list__pair">
                <dt>Work items</dt>
                <dd>{items.length}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Blocked</dt>
                <dd>{blocked.length}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Past due</dt>
                <dd>{overdue.length}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Finished</dt>
                <dd>
                  {done.length} of {items.length}
                </dd>
              </div>
            </dl>
            <p className="tm-field__hint">
              These are counts, not a score. Every one of them is a number you can check in the work
              list.
            </p>
            {items.length >= MAX_WORK_ITEM_PAGE ? (
              <InlineAlert tone="warning" title="These counts are a page, not a total">
                This project has at least {MAX_WORK_ITEM_PAGE} work items, which is a full page from
                the API. The counts above describe what was fetched, not the whole project.
              </InlineAlert>
            ) : null}
          </>
        )}
      </section>

      <WorkSection
        id="tm-project-next"
        title="Next actions"
        empty="Nothing is ready or in progress. Everything is either in the backlog or finished."
        items={nextActions}
        organizationSlug={organizationSlug}
        now={now}
      />

      <WorkSection
        id="tm-project-blockers"
        title="Blockers"
        empty="Nothing is blocked."
        items={blocked}
        organizationSlug={organizationSlug}
        now={now}
      />

      <section className="tm-panel tm-stack" aria-labelledby="tm-project-client">
        <h2 id="tm-project-client" className="tm-eyebrow">
          What the client can see
        </h2>
        {clientFacing.length === 0 ? (
          <p className="tm-prose">
            Nothing in this project is shared with a client. Every item is internal, which is what a
            new item starts as.
          </p>
        ) : (
          <>
            <p className="tm-prose">
              {clientFacing.length === 1
                ? 'One item is visible in the client portal.'
                : `${clientFacing.length} items are visible in the client portal.`}
            </p>
            <ul className="tm-list">
              {clientFacing.map((item) => (
                <li key={item.id}>
                  <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>{' '}
                  <StateCapsule state="client">{audienceLabel(item.audience)}</StateCapsule>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="tm-field__hint">
          This is what the client portal shows for this project. The portal is built and live, so
          the list is what a client member reading it right now would see — not a preview of
          something later.
        </p>
      </section>

      <MilestoneComposer api={api} organizationSlug={organizationSlug} projectId={projectId} />

      <UpdateComposer api={api} organizationSlug={organizationSlug} projectId={projectId} />

      <BackendPending ticket="internal pulse — unscheduled">
        The latest internal pulse is not built and is not scheduled to be. It has nowhere to be
        stored yet, so it is not drawn: an empty “Pulse” heading would read as a team that has said
        nothing rather than a feature that does not exist.
      </BackendPending>
    </AppShell>
  );
}

interface WorkSectionProps {
  id: string;
  title: string;
  empty: string;
  items: readonly WorkItemSummary[];
  organizationSlug: string;
  now: Date;
}

function WorkSection({ id, title, empty, items, organizationSlug, now }: WorkSectionProps) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby={id}>
      <h2 id={id} className="tm-eyebrow">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="tm-prose">{empty}</p>
      ) : (
        <ul className="tm-list">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>{' '}
              <StateCapsule state={stateCapsule(item.state)}>{stateLabel(item.state)}</StateCapsule>{' '}
              <span className="tm-prose">{formatInstant(item.dueAt)}</span>
              {isOverdue(item, now) ? (
                <>
                  {' '}
                  <StateCapsule state="blocked">Overdue</StateCapsule>
                </>
              ) : null}
            </li>
          ))}
        </ul>
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
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [status, setStatus] = useState<MilestoneStatus>('planned');
  const [publishNow, setPublishNow] = useState(true);

  const milestones = useQuery({
    queryKey: ['project-milestones', organizationSlug, projectId],
    queryFn: () => listProjectMilestones(api, organizationSlug, projectId),
  });

  const create = useMutation({
    mutationFn: () =>
      createProjectMilestone(api, organizationSlug, projectId, {
        title: title.trim(),
        dueOn: dueOn === '' ? null : dueOn,
        status,
        published: publishNow,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['project-milestones', organizationSlug, projectId],
      });
      void queries.invalidateQueries({ queryKey: ['portal-milestones', organizationSlug, projectId] });
      setTitle('');
      setDueOn('');
      setStatus('planned');
      setPublishNow(true);
    },
  });

  const canCreate = title.trim() !== '' && !create.isPending;
  const rows: readonly ProjectMilestone[] = milestones.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-project-milestones">
      <h2 id="tm-project-milestones" className="tm-eyebrow">
        Milestones
      </h2>

      {milestones.isError ? (
        <InlineAlert tone="danger" title="Could not load milestones" live>
          {describe(milestones.error)}
        </InlineAlert>
      ) : rows.length === 0 ? (
        <p className="tm-prose">No milestones yet. Add the first below.</p>
      ) : (
        <ol className="tm-list tm-stack">
          {rows.map((milestone) => (
            <li key={milestone.id} className="tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <h3 className="tm-heading-3">{milestone.title}</h3>
                <StateCapsule state={milestoneCapsuleState(milestone.status)} className="tm-push-end">
                  {milestone.status}
                </StateCapsule>
                {!milestone.published ? <StateCapsule state="neutral">Draft</StateCapsule> : null}
              </div>
              <p className="tm-field__hint">
                {milestone.dueOn === null ? 'No date committed' : `Due ${formatDay(milestone.dueOn)}`}
              </p>
            </li>
          ))}
        </ol>
      )}

      <form
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) create.mutate();
        }}
      >
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
            onChange={(event) => setStatus(event.target.value as MilestoneStatus)}
          >
            {MILESTONE_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <label className="tm-choice tm-choice--inline">
          <input
            className="tm-choice__input"
            type="checkbox"
            checked={publishNow}
            onChange={(event) => setPublishNow(event.target.checked)}
          />
          <span className="tm-choice__name">Publish to the client now</span>
        </label>
        <span className="tm-field__hint">
          A published milestone is visible in the client portal straight away. Leave this unchecked
          to keep it a draft only your studio can see. Editing or unpublishing a milestone is not
          built yet, so add it the way you mean it.
        </span>

        {create.isError ? (
          <InlineAlert tone="danger" title="Could not add the milestone" live>
            {describe(create.error)}
          </InlineAlert>
        ) : null}
        {create.isSuccess ? (
          <InlineAlert tone="success" title="Milestone added" live>
            {publishNow
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
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [publishNow, setPublishNow] = useState(true);

  const post = useMutation({
    mutationFn: () =>
      postProjectUpdate(api, organizationSlug, projectId, {
        title: title.trim(),
        body: body.trim(),
        published: publishNow,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['portal-updates', organizationSlug, projectId] });
      setTitle('');
      setBody('');
      setPublishNow(true);
    },
  });

  const canPost = title.trim() !== '' && body.trim() !== '' && !post.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-project-update-composer">
      <h2 id="tm-project-update-composer" className="tm-eyebrow">
        Post an update
      </h2>

      <form
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (canPost) post.mutate();
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
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        <label className="tm-choice tm-choice--inline">
          <input
            className="tm-choice__input"
            type="checkbox"
            checked={publishNow}
            onChange={(event) => setPublishNow(event.target.checked)}
          />
          <span className="tm-choice__name">Publish to the client now</span>
        </label>
        <span className="tm-field__hint">
          A published update is visible in the client portal straight away. Leave this unchecked to
          keep it a draft only your studio can see. Editing or unpublishing an update is not built
          yet, so post it the way you mean it.
        </span>

        {post.isError ? (
          <InlineAlert tone="danger" title="Could not post the update" live>
            {describe(post.error)}
          </InlineAlert>
        ) : null}
        {post.isSuccess ? (
          <InlineAlert tone="success" title="Update posted" live>
            {publishNow
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
