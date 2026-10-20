'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell, DayPulseBar } from '../shell/AppShell';
import type { DayPulseItem } from '../shell/AppShell';
import { HomeHeroSection } from './HomeHeroSection';
import { HomePinnedSection } from './HomePinnedSection';
import { HomeRecentItemsView } from './HomeRecentItemsView';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomeSummary, getMyDay, getSavedContext, getWaiting } from '../../lib/api/home';
import type {
  HomeSummary,
  MyDay,
  MyDayReason,
  SavedContextEntityType,
  Waiting,
  WaitingReason,
} from '../../lib/api/home';
import { listProjects } from '../../lib/api/projects';
import { getCalendarGrid } from '../../lib/api/calendar-grid';
import { listFocusBlocks } from '../../lib/api/focus-blocks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatDay, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/home.css';

export interface MyDayScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

type MyDayEntry = MyDay['items'][number];
type WaitingEntry = Waiting['items'][number];
type CardFilter = 'all' | 'overdue' | 'due_soon';

/**
 * **HOME-01 My Day** — the first destination on the internal rail, drawn to the design handoff's
 * HOME-01 frame: the black day capsule, the 64px "MY DAY" display headline with its "New work"
 * capsule and three header metrics, the black Focus Capsule naming the one thing to do next,
 * "Due & at risk" as bento cards (the first one lime), "Waiting on you" as a row list, the
 * HOME-03 personal-work list grouped by project, and — in the right column — the HOME-05 saved
 * context (Saved, Pinned, Recently viewed).
 *
 * ## A faithful reader
 *
 * Every number, title and row comes from the API: `/home/my-day` ranks the acting user's own open
 * work (overdue → due soon → the rest) and names a reason per row; `/home/waiting` lists
 * approvals pending on them and client requests awaiting triage; `/home/summary` and
 * `/home/pulse` are the derived counts. The day capsule shows only real meetings and focus
 * blocks for today. Where the design shows data the API does not have yet (owner names on a
 * card, the project context lens, delegated "waiting on others") the screen draws what it does
 * know rather than inventing it.
 */
export function MyDayScreen({ organizationSlug, organizationName, client }: MyDayScreenProps) {
  const api = client ?? browserApiClient();
  const [filter, setFilter] = useState<CardFilter>('all');

  const myDay = useQuery({
    queryKey: ['home', 'my-day', organizationSlug],
    queryFn: () => getMyDay(api, organizationSlug),
  });

  const waiting = useQuery({
    queryKey: ['home', 'waiting', organizationSlug],
    queryFn: () => getWaiting(api, organizationSlug),
  });

  const summary = useQuery({
    queryKey: ['home', 'summary', organizationSlug],
    queryFn: () => getHomeSummary(api, organizationSlug),
  });

  const saved = useQuery({
    queryKey: ['home', 'saved-context', organizationSlug],
    queryFn: () => getSavedContext(api, organizationSlug),
  });

  // Names for the project each item belongs to — My Day spans every project, so an id alone
  // would not tell the reader which one. One directory, resolved through a map, no fetch per row.
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const pulseItems = useDayPulseItems(api, organizationSlug);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);
  const projectName = (id: string): string => projectNames.get(id) ?? 'Another project';

  const items = useMemo(() => myDay.data?.items ?? [], [myDay.data]);
  const waitingItems = waiting.data?.items ?? [];
  const savedGroups = saved.data?.groups ?? [];

  const overdueCount = items.filter((entry) => entry.reason === 'overdue').length;
  const dueSoonCount = items.filter((entry) => entry.reason === 'due_soon').length;
  const cards = items.filter((entry) => filter === 'all' || entry.reason === filter).slice(0, 3);
  const top = items[0];

  const groups = useMemo(() => groupByProject(items), [items]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title="My Day"
      titleVariant="display"
      actionsPlacement="inline"
      actions={
        <Link
          href={`/${organizationSlug}/capture`}
          className="tm-button tm-button--ink tm-button--feature"
        >
          <span className="tm-button__orb" aria-hidden="true">
            +
          </span>
          New work
        </Link>
      }
      description={describeDay(summary.data, summary.isPending || summary.isError)}
      headerAside={<HomeHeroSection organizationSlug={organizationSlug} client={client} />}
      topBar={
        <DayPulseBar
          organizationSlug={organizationSlug}
          items={pulseItems}
          nowLabel={top ? top.workItem.title : 'Nothing scheduled right now'}
        />
      }
    >
      {summary.isError ? (
        <InlineAlert tone="danger" title="Could not load your summary" live>
          {describeSummaryError(summary.error)}
        </InlineAlert>
      ) : null}

      {top ? (
        <div className="tm-focus-capsule tm-home-focus" role="group" aria-label="Do this next">
          <span className="tm-focus-capsule__orb" aria-hidden="true">
            ▸
          </span>
          <div className="tm-focus-capsule__text">
            <p className="tm-focus-capsule__title">
              <Link href={`/${organizationSlug}/work/${top.workItem.id}`}>
                {top.workItem.title}
              </Link>
            </p>
            <p className="tm-focus-capsule__why">
              Why now — {whyNow(top)} in {projectName(top.workItem.projectId)}.
            </p>
          </div>
          <div className="tm-focus-capsule__end">
            <span className="tm-home-focus__flag">
              <span className="tm-home-focus__flag-glyph" aria-hidden="true">
                !
              </span>
              {stateLabel(top.workItem.state)}
            </span>
            <Link
              href={`/${organizationSlug}/work/${top.workItem.id}`}
              className="tm-home-focus__go"
              aria-label={`Open ${top.workItem.title}`}
            >
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      ) : null}

      <div className="tm-home-body">
        <div className="tm-home-main">
          <section className="tm-home-section" aria-labelledby="tm-my-day-personal">
            <div className="tm-section-head">
              <h2 id="tm-my-day-personal" className="tm-section-head__title">
                Due &amp; at risk
              </h2>
              <span className="tm-section-head__meta tm-home-section__count">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
              <div className="tm-section-head__end tm-chip-row" role="group" aria-label="Show">
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'overdue'}
                  onClick={() => setFilter('overdue')}
                >
                  Overdue · {overdueCount}
                </button>
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'due_soon'}
                  onClick={() => setFilter('due_soon')}
                >
                  Due soon · {dueSoonCount}
                </button>
              </div>
            </div>

            {myDay.isError ? (
              <InlineAlert tone="danger" title="Could not load your work" live>
                {describeError(myDay.error)}
              </InlineAlert>
            ) : null}

            {myDay.isPending ? (
              <LoadingRegion label="Loading your work.">
                <Skeleton height="180px" radius="var(--r-card)" />
              </LoadingRegion>
            ) : null}

            {!myDay.isPending && !myDay.isError && items.length === 0 ? (
              <div className="tm-card tm-card--empty tm-home-empty">
                <h3 className="tm-card__title">Nothing needs you right now</h3>
                <p className="tm-card__meta">
                  You have no open work assigned to you. Work assigned to you across any project
                  shows up here, with what is overdue or due soon first.
                </p>
              </div>
            ) : null}

            {items.length > 0 && cards.length === 0 ? (
              <div className="tm-card tm-card--empty tm-home-empty">
                <h3 className="tm-card__title">
                  {filter === 'overdue' ? 'Nothing is overdue' : 'Nothing is due soon'}
                </h3>
                <p className="tm-card__meta">Everything else that needs you is listed below.</p>
              </div>
            ) : null}

            {cards.length > 0 ? (
              <ul className="tm-home-cards" aria-label="Your work, ranked">
                {cards.map((entry, index) => (
                  <li key={entry.workItem.id}>
                    <WorkCard
                      entry={entry}
                      lime={index === 0 && filter === 'all'}
                      organizationSlug={organizationSlug}
                      projectName={projectName(entry.workItem.projectId)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            className="tm-home-section tm-home-section--quiet"
            aria-labelledby="tm-my-day-waiting"
          >
            <div className="tm-section-head">
              <h2 id="tm-my-day-waiting" className="tm-section-head__title">
                Waiting on you
              </h2>
              <span className="tm-section-head__meta">
                reviews and client requests that cannot move until you act
              </span>
            </div>

            {waiting.isError ? (
              <InlineAlert tone="danger" title="Could not load what is waiting on you" live>
                {describeWaitingError(waiting.error)}
              </InlineAlert>
            ) : null}

            {waiting.isPending ? (
              <LoadingRegion label="Loading what is waiting on you.">
                <Skeleton height="44px" />
                <Skeleton height="44px" />
              </LoadingRegion>
            ) : null}

            {!waiting.isPending && !waiting.isError && waitingItems.length === 0 ? (
              <div className="tm-card tm-card--empty tm-home-empty">
                <h3 className="tm-card__title">Nothing is waiting on you</h3>
                <p className="tm-card__meta">
                  You have no reviews pending and no client requests to triage. Approvals assigned
                  to you, client requests awaiting your triage, and stale follow-ups across any
                  project show up here, with what needs you first.
                </p>
              </div>
            ) : null}

            {waitingItems.length > 0 ? (
              <ul className="tm-row-list tm-home-rows" aria-label="Waiting on you">
                {waitingItems.map((entry) => (
                  <WaitingRow
                    key={entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId}
                    entry={entry}
                    organizationSlug={organizationSlug}
                    projectName={projectName(entry.projectId)}
                  />
                ))}
              </ul>
            ) : null}
          </section>

          {groups.length > 0 ? (
            <section
              className="tm-home-section tm-home-section--quiet"
              aria-labelledby="tm-my-day-all"
            >
              <div className="tm-section-head">
                <h2 id="tm-my-day-all" className="tm-section-head__title">
                  Personal work
                </h2>
                <span className="tm-section-head__meta">
                  {groups.length} {groups.length === 1 ? 'project' : 'projects'}
                </span>
              </div>
              <ul className="tm-home-groups" aria-label="Your open work, by project">
                {groups.map((group) => (
                  <li key={group.projectId} className="tm-home-group">
                    <h3 className="tm-home-group__head">
                      <span>{projectName(group.projectId)}</span>
                      <span className="tm-home-group__count">{group.entries.length}</span>
                    </h3>
                    <ul className="tm-home-group__rows">
                      {group.entries.map((entry) => (
                        <li key={entry.workItem.id}>
                          <span className="tm-home-group__type" aria-hidden="true">
                            {typeCode(entry.workItem.type)}
                          </span>
                          <span className="tm-home-group__title">
                            <Link href={`/${organizationSlug}/work/${entry.workItem.id}`}>
                              {entry.workItem.title}
                            </Link>
                          </span>
                          <StateCapsule state={stateCapsule(entry.workItem.state)}>
                            {stateLabel(entry.workItem.state)}
                          </StateCapsule>
                          <span
                            className="tm-meta-mono tm-home-group__due"
                            data-reason={entry.reason}
                          >
                            {shortDay(entry.workItem.dueAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="tm-home-side">
          <section className="tm-home-saved" aria-labelledby="tm-my-day-saved">
            <div className="tm-home-saved__head">
              <h2 id="tm-my-day-saved" className="tm-home-saved__heading">
                Saved
              </h2>
              {savedGroups.length > 0 ? (
                <span className="tm-home-saved__count">
                  {savedGroups.reduce((total, group) => total + group.items.length, 0)} saved
                </span>
              ) : null}
            </div>

            {saved.isError ? (
              <InlineAlert tone="danger" title="Could not load your saved items" live>
                {describeSavedError(saved.error)}
              </InlineAlert>
            ) : null}

            {saved.isPending ? (
              <LoadingRegion label="Loading your saved items.">
                <Skeleton height="52px" radius="var(--r-control)" />
              </LoadingRegion>
            ) : null}

            {!saved.isPending && !saved.isError && savedGroups.length === 0 ? (
              <p className="tm-home-saved__empty">
                <strong>Nothing saved yet</strong>
                Messages, docs, work and files you pin are kept here, grouped by project, so you can
                return to them from any screen.
              </p>
            ) : null}

            {savedGroups.map((group) => (
              <div key={group.projectId} className="tm-home-saved__block">
                <h3 className="tm-home-saved__group">{projectName(group.projectId)}</h3>
                <ul
                  className="tm-home-saved__list"
                  aria-label={`Saved in ${projectNames.get(group.projectId) ?? 'another project'}`}
                >
                  {group.items.map((item) => (
                    <li key={item.id} className="tm-home-saved__item" data-kind={item.entityType}>
                      <span className="tm-home-orb" aria-hidden="true">
                        {savedGlyph(item.entityType)}
                      </span>
                      <span className="tm-home-saved__text">
                        <span className="tm-home-saved__title">
                          {item.entityType === 'work' ? (
                            <Link href={`/${organizationSlug}/work/${item.entityId}`}>
                              {savedTypeLabel(item.entityType)}
                            </Link>
                          ) : (
                            <span>{savedTypeLabel(item.entityType)}</span>
                          )}
                        </span>
                        <span className="tm-home-saved__meta">
                          {item.entityType} · saved {shortDay(item.createdAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <HomePinnedSection organizationSlug={organizationSlug} client={client} />

          <HomeRecentItemsView organizationSlug={organizationSlug} client={client} />
        </div>
      </div>
    </AppShell>
  );
}

/** One "Due & at risk" card: the first is the lime one, the rest white (HOME-01). */
function WorkCard({
  entry,
  lime,
  organizationSlug,
  projectName,
}: {
  entry: MyDayEntry;
  lime: boolean;
  organizationSlug: string;
  projectName: string;
}) {
  const href = `/${organizationSlug}/work/${entry.workItem.id}`;
  return (
    <article className={`tm-card tm-home-card${lime ? ' tm-card--lime' : ''}`}>
      <div className="tm-home-card__top">
        <span className="tm-card__eyebrow">
          <span className="tm-home-orb" aria-hidden="true">
            {typeGlyph(entry.workItem.type)}
          </span>
          <span className="tm-home-card__eyebrow-text">
            {typeWord(entry.workItem.type)} · {projectName}
          </span>
        </span>
        <span className="tm-home-orb" aria-hidden="true">
          ↗
        </span>
      </div>
      <h3 className="tm-card__title">
        <Link href={href}>{entry.workItem.title}</Link>
      </h3>
      <div className="tm-home-card__foot">
        <span className="tm-card__meta">
          {entry.workItem.dueAt ? `due ${shortDay(entry.workItem.dueAt)}` : 'no due date'} ·{' '}
          {reasonLabel(entry.reason).toLowerCase()}
        </span>
        <StateCapsule state={stateCapsule(entry.workItem.state)}>
          {stateLabel(entry.workItem.state)}
        </StateCapsule>
      </div>
    </article>
  );
}

/** One "Waiting on you" row: who/what, the status in a word, since when, and the way in. */
function WaitingRow({
  entry,
  organizationSlug,
  projectName,
}: {
  entry: WaitingEntry;
  organizationSlug: string;
  projectName: string;
}) {
  const isApproval = entry.kind === 'approval';
  const title = isApproval ? 'Deliverable review' : entry.title;
  const since = isApproval ? entry.requestedAt : entry.waitingSince;
  // REQ-11: Triage opens the request itself, not the general inbox the person then has to search.
  const href =
    entry.kind === 'approval'
      ? `/${organizationSlug}/projects/${entry.projectId}`
      : `/${organizationSlug}/work/requests/${entry.clientRequestId}`;
  return (
    <li>
      <span className={`tm-avatar${isApproval ? '' : ' tm-avatar--client'}`} aria-hidden="true">
        {isApproval ? '◆' : '◎'}
      </span>
      <span className="tm-home-rows__title">
        {title} <span className="tm-home-rows__project">· {projectName}</span>
      </span>
      <span className="tm-home-rows__status" data-tone={waitingTone(entry.reason)}>
        {waitingReasonLabel(entry.reason)}
      </span>
      <span className="tm-meta-mono tm-home-rows__when">since {shortDay(since)}</span>
      <Link href={href} className="tm-button tm-button--outline tm-button--compact">
        {isApproval ? 'Review' : 'Triage'}
        <span className="tm-visually-hidden">: {title}</span>
      </Link>
    </li>
  );
}

/**
 * Today's real meetings and focus blocks, as the day capsule's slots. Meetings come from the
 * calendar grid (this week, anchored today) and blocks from the caller's own focus blocks. A
 * meeting is "now" for 30 minutes after it starts (the grid carries no end); a block is "now"
 * between its start and end. Nothing is invented: no data, no slots.
 */
function useDayPulseItems(api: ApiClient, organizationSlug: string): DayPulseItem[] {
  const today = useMemo(() => todayWindow(), []);

  const grid = useQuery({
    queryKey: ['calendar-grid', organizationSlug, 'week', today.anchor],
    queryFn: () => getCalendarGrid(api, organizationSlug, { range: 'week', anchor: today.anchor }),
  });

  const blocks = useQuery({
    queryKey: ['focus-blocks', organizationSlug, today.from, today.to],
    queryFn: () => listFocusBlocks(api, organizationSlug, today.from, today.to),
  });

  return useMemo(() => {
    const now = Date.now();
    const slots: { id: string; start: number; end: number; label: string; href: string }[] = [];
    const days = Array.isArray(grid.data?.days) ? grid.data.days : [];
    for (const day of days) {
      for (const meeting of Array.isArray(day.meetings) ? day.meetings : []) {
        const start = Date.parse(meeting.startsAt);
        if (Number.isNaN(start) || start < today.fromMs || start >= today.toMs) continue;
        slots.push({
          id: `meeting-${meeting.id}`,
          start,
          end: start + 30 * 60_000,
          label: meeting.title,
          href: `/${organizationSlug}/calendar`,
        });
      }
    }
    for (const block of Array.isArray(blocks.data) ? blocks.data : []) {
      const start = Date.parse(block.startsAt);
      const end = Date.parse(block.endsAt);
      if (Number.isNaN(start) || start < today.fromMs || start >= today.toMs) continue;
      slots.push({
        id: `focus-${block.id}`,
        start,
        end: Number.isNaN(end) ? start : end,
        label: block.title,
        href: `/${organizationSlug}/calendar`,
      });
    }
    slots.sort((a, b) => a.start - b.start);
    let nextSeen = false;
    return slots.map((slot): DayPulseItem => {
      let state: DayPulseItem['state'];
      if (slot.end <= now) state = 'done';
      else if (slot.start <= now) state = 'now';
      else if (!nextSeen) {
        state = 'next';
        nextSeen = true;
      } else state = 'later';
      return {
        id: slot.id,
        time: new Date(slot.start).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        label: slot.label,
        state,
        href: slot.href,
      };
    });
  }, [grid.data, blocks.data, organizationSlug, today]);
}

function todayWindow() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    anchor: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    from: start.toISOString(),
    to: end.toISOString(),
    fromMs: start.getTime(),
    toMs: end.getTime(),
  };
}

function groupByProject(items: readonly MyDayEntry[]) {
  const order: string[] = [];
  const byProject = new Map<string, MyDayEntry[]>();
  for (const entry of items) {
    const id = entry.workItem.projectId;
    const list = byProject.get(id);
    if (list) list.push(entry);
    else {
      byProject.set(id, [entry]);
      order.push(id);
    }
  }
  return order.map((projectId) => ({ projectId, entries: byProject.get(projectId) ?? [] }));
}

/** The sentence under the headline, from the API's derived counts. */
function describeDay(summary: HomeSummary | undefined, unknown: boolean): string {
  if (unknown || !summary) return 'What needs you today, across every project.';
  const total = summary.personalWork.total + summary.waiting.total;
  if (total === 0) return 'Nothing needs you right now. New work and reviews will show up here.';
  const parts: string[] = [];
  if (summary.personalWork.overdue > 0) parts.push(`${summary.personalWork.overdue} overdue`);
  if (summary.personalWork.dueSoon > 0) parts.push(`${summary.personalWork.dueSoon} due soon`);
  if (summary.waiting.total > 0) parts.push(`${summary.waiting.total} waiting on your answer`);
  const lead = `${spell(total)} ${total === 1 ? 'thing needs' : 'things need'} you today.`;
  return parts.length > 0 ? `${lead} ${capitalise(parts.join(', '))}.` : lead;
}

function spell(value: number): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  return words[value] ?? String(value);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Why now" — the ranking reason in words, with the date when there is one. */
function whyNow(entry: MyDayEntry): string {
  const due = entry.workItem.dueAt ? shortDay(entry.workItem.dueAt) : null;
  switch (entry.reason) {
    case 'overdue':
      return due ? `it was due ${due} and is still open` : 'it is overdue';
    case 'due_soon':
      return due ? `it is due ${due}` : 'it is due soon';
    case 'assigned':
      return due ? `it is yours, due ${due}` : 'it is yours and first in your list';
  }
}

/** "18 Aug" — the design's short day; the full instant stays one click away on the item. */
function shortDay(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatDay(value);
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function typeCode(type: string): string {
  switch (type) {
    case 'task':
      return 'TSK';
    case 'deliverable':
      return 'DEL';
    case 'doc':
    case 'document':
      return 'DOC';
    case 'bug':
      return 'BUG';
    case 'milestone':
      return 'MLS';
    default:
      return type.slice(0, 3).toUpperCase();
  }
}

function typeWord(type: string): string {
  return type.length > 0 ? type.charAt(0).toUpperCase() + type.slice(1) : 'Work';
}

function typeGlyph(type: string): string {
  switch (type) {
    case 'deliverable':
      return '◆';
    case 'doc':
    case 'document':
      return '◫';
    case 'milestone':
      return '◉';
    default:
      return '▤';
  }
}

function savedGlyph(entityType: SavedContextEntityType): string {
  switch (entityType) {
    case 'message':
      return '◌';
    case 'doc':
      return '◫';
    case 'work':
      return '▤';
    case 'file':
      return '⇪';
  }
}

/** The word each pinned reference shows. The live title/preview is the deferred read-fan-out. */
function savedTypeLabel(entityType: SavedContextEntityType): string {
  switch (entityType) {
    case 'message':
      return 'Saved message';
    case 'doc':
      return 'Saved document';
    case 'work':
      return 'Saved work item';
    case 'file':
      return 'Saved file';
  }
}

function describeSavedError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your saved items loaded.';
  return 'Something went wrong loading your saved items.';
}

/** The word each ranking reason shows — the capsule is never colour alone. */
function reasonLabel(reason: MyDayReason): string {
  switch (reason) {
    case 'overdue':
      return 'Overdue';
    case 'due_soon':
      return 'Due soon';
    case 'assigned':
      return 'Assigned';
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your work loaded.';
  return 'Something went wrong loading your work.';
}

/** The word each waiting reason shows — the status is never colour alone. */
function waitingReasonLabel(reason: WaitingReason): string {
  switch (reason) {
    case 'approval_requested':
      return 'Review requested';
    case 'approval_viewed':
      return 'In review';
    case 'client_submitted':
      return 'New request';
    case 'client_triage':
      return 'In triage';
    case 'stale_follow_up':
      return 'Follow up';
  }
}

function waitingTone(reason: WaitingReason): 'warning' | 'danger' | 'neutral' {
  switch (reason) {
    case 'approval_requested':
    case 'client_submitted':
      return 'warning';
    case 'stale_follow_up':
      return 'danger';
    case 'approval_viewed':
    case 'client_triage':
      return 'neutral';
  }
}

function describeWaitingError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your reviews loaded.';
  return 'Something went wrong loading what is waiting on you.';
}

function describeSummaryError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your summary loaded.';
  return 'Something went wrong loading your summary.';
}
