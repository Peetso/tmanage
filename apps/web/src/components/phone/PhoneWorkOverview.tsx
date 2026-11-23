'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { StateCapsule } from '@tmanage/ui';
import { PhoneIcon } from '../icons/phone';
import type { PhoneIconName } from '../icons/phone';
import { PhoneProgressRing } from './PhoneProgressRing';
import { OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import { directKeys, fetchDirectConversations } from '../../lib/api/direct-conversations';
import type { ApiClient } from '../../lib/api/client';
import type { ProjectSummary } from '../../lib/api/projects';
import type { WorkItemSummary } from '../../lib/api/work-items';
import { stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import { fill } from '../../lib/privacy-presentation';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import '../../styles/phone/work.css';
import { appDateLocale } from '../../lib/i18n/app-locale';

export type PhoneWorkFilter = 'mine' | 'week' | 'client';

export interface PhoneWorkOverviewProps {
  api: ApiClient;
  organizationSlug: string;
  organizationName: string;
  rows: readonly WorkItemSummary[];
  projects: readonly ProjectSummary[];
  now: Date;
}

/**
 * **Phone · Work list** (Figma 407:6488): the big "Work" title with search and new-work orbs,
 * three quick filters, the two busiest projects as cards with a progress ring, then the filtered
 * list. Drawn only below 768px (`styles/phone/work.css`); the desktop table is untouched.
 *
 * Everything is derived from the rows the screen already loaded: a project's ring is its done
 * share of the loaded items, its launch is the committed date (else the forecast). The design's
 * Plan / Review / Approve / Deliver steps have no field behind them yet, so they are not drawn.
 */
export function PhoneWorkOverview({
  api,
  organizationSlug,
  organizationName,
  rows,
  projects,
  now,
}: PhoneWorkOverviewProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [filter, setFilter] = useState<PhoneWorkFilter>('mine');

  // The caller's id rides on the direct-conversations overview (the same cache entry chat uses).
  const overview = useQuery({
    queryKey: directKeys.overview(organizationSlug),
    queryFn: () => fetchDirectConversations(api, organizationSlug),
  });
  const viewerUserId = overview.data?.viewerUserId ?? null;

  const lists = useMemo(() => phoneWorkLists(rows, viewerUserId, now), [rows, viewerUserId, now]);
  const cards = useMemo(() => projectCards(rows, projects), [rows, projects]);
  const visible = lists[filter];

  const chips: { id: PhoneWorkFilter; label: string; count?: number }[] = [
    { id: 'mine', label: tOr('PhoneWork.mine', 'Mine'), count: lists.mine.length },
    { id: 'week', label: tOr('PhoneWork.dueThisWeek', 'Due this week') },
    { id: 'client', label: tOr('PhoneWork.clientWaiting', 'Client waiting') },
  ];
  const heading =
    filter === 'client'
      ? tOr('PhoneWork.clientWaiting', 'Client waiting')
      : tOr('PhoneWork.thisWeek', 'This week');
  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? tOr('PhoneWork.project', 'Project');

  return (
    <div className="tm-phone-work">
      <div className="tm-phone-work__titlebar">
        <div className="tm-phone-work__titles" aria-hidden="true">
          <p className="tm-phone-work__org">{organizationName}</p>
          <p className="tm-phone-work__title">{tOr('PhoneWork.title', 'Work')}</p>
        </div>
        <div className="tm-phone-work__orbs">
          <button
            type="button"
            className="tm-phone-work__orb"
            aria-label={tOr('PhoneWork.search', 'Search work')}
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
          >
            <PhoneIcon name="search" />
          </button>
          <Link
            href={`/${organizationSlug}/capture`}
            className="tm-phone-work__orb"
            data-tone="ink"
            aria-label={tOr('PhoneWork.newWork', 'New work')}
          >
            <PhoneIcon name="plus" />
          </Link>
        </div>
      </div>

      <div className="tm-phone-work__chips" role="group" aria-label={tOr('PhoneWork.show', 'Show')}>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="tm-phone-work__chip"
            aria-pressed={filter === chip.id}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label}
            {chip.count === undefined ? null : (
              <span className="tm-phone-work__chip-count">{chip.count}</span>
            )}
          </button>
        ))}
      </div>

      {cards.map((card, index) => {
        const launch = card.project.committedAt ?? card.project.forecastAt;
        const percentLabel = fill(tOr('PhoneWork.percentDone', '{percent}% done'), {
          percent: card.percent,
        });
        return index === 0 ? (
          <section key={card.project.id} className="tm-phone-work__project" data-tone="ink">
            <div className="tm-phone-work__project-top">
              <p className="tm-phone-work__project-eyebrow">
                {tOr('PhoneWork.project', 'Project')}
              </p>
              <Link
                href={`/${organizationSlug}/projects/${card.project.id}`}
                className="tm-phone-work__arrow"
                aria-label={`${tOr('PhoneWork.openProject', 'Open project')}: ${card.project.name}`}
              >
                <PhoneIcon name="arrow" size={16} />
              </Link>
            </div>
            <h2 className="tm-phone-work__project-name">{card.project.name}</h2>
            <div className="tm-phone-work__project-row">
              <PhoneProgressRing percent={card.percent} size={64} label={percentLabel} />
              <div className="tm-phone-work__project-text">
                <p className="tm-phone-work__project-launch">
                  {launch
                    ? fill(tOr('PhoneWork.launch', 'Launch {date}'), {
                        date: phoneDay(launch, locale),
                      })
                    : tOr('PhoneWork.noLaunch', 'No launch date yet')}
                </p>
                <p className="tm-phone-work__project-sub">
                  {fill(
                    tOr('PhoneWork.openWaiting', '{open} open · {client} waiting on the client'),
                    {
                      open: card.open,
                      client: card.clientWaiting,
                    },
                  )}
                </p>
              </div>
            </div>
          </section>
        ) : (
          <section key={card.project.id} className="tm-phone-work__project" data-tone="paper">
            <div className="tm-phone-work__project-row">
              <PhoneProgressRing percent={card.percent} size={56} label={percentLabel} />
              <div className="tm-phone-work__project-text">
                <p className="tm-phone-work__project-eyebrow">
                  {fill(tOr('PhoneWork.openCount', '{open} open'), { open: card.open })}
                </p>
                <h2 className="tm-phone-work__project-name">
                  <Link href={`/${organizationSlug}/projects/${card.project.id}`}>
                    {card.project.name}
                  </Link>
                </h2>
                {card.next ? (
                  <p className="tm-phone-work__project-sub">
                    {fill(tOr('PhoneWork.next', 'Next: {title} · {date}'), {
                      title: card.next.title,
                      date: card.next.dueAt ? phoneDay(card.next.dueAt, locale) : '—',
                    })}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        );
      })}

      <section className="tm-phone-work__section" aria-labelledby="tm-phone-work-list">
        <div className="tm-phone-work__head">
          <h2 id="tm-phone-work-list" className="tm-phone-work__heading">
            {heading}
          </h2>
          <span className="tm-phone-work__badge">{visible.length}</span>
        </div>
        {visible.length === 0 ? (
          <p className="tm-phone-work__empty">
            {tOr('PhoneWork.nothing', 'Nothing here right now.')}
          </p>
        ) : (
          <ul className="tm-phone-work__list">
            {visible.map((item) => (
              <li key={item.id} className="tm-phone-work__row">
                <span className="tm-phone-work__row-orb" aria-hidden="true">
                  <PhoneIcon name={rowIcon(item)} size={20} />
                </span>
                <span className="tm-phone-work__row-text">
                  <Link
                    href={`/${organizationSlug}/work/${item.id}`}
                    className="tm-phone-work__row-title"
                  >
                    {item.title}
                  </Link>
                  <span className="tm-phone-work__row-meta">
                    {projectName(item.projectId)} ·{' '}
                    {item.state === 'done' && item.completedAt
                      ? `${tOr('PhoneWork.done', 'Done')} ${phoneDay(item.completedAt, locale)}`
                      : item.dueAt
                        ? phoneDay(item.dueAt, locale)
                        : tOr('PhoneWork.noDue', 'No due date')}
                  </span>
                </span>
                <StateCapsule state={stateCapsule(item.state)}>
                  {stateLabel(item.state)}
                </StateCapsule>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The three quick lists. Open work only, soonest due first; "this week" ends seven days out. */
export function phoneWorkLists(
  rows: readonly WorkItemSummary[],
  viewerUserId: string | null,
  now: Date,
): Record<PhoneWorkFilter, WorkItemSummary[]> {
  const weekEnd = now.getTime() + 7 * 24 * 60 * 60 * 1000;
  const open = rows.filter((row) => row.state !== 'done' && row.state !== 'archived');
  const dueThisWeek = open
    .filter((row) => row.dueAt !== null && Date.parse(row.dueAt) <= weekEnd)
    .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''));
  return {
    mine: dueThisWeek.filter((row) => viewerUserId !== null && row.ownerUserId === viewerUserId),
    week: dueThisWeek,
    client: open.filter((row) => row.audience === 'client_action_required'),
  };
}

interface ProjectCard {
  project: ProjectSummary;
  percent: number;
  open: number;
  clientWaiting: number;
  next: WorkItemSummary | undefined;
}

/** The two projects with the most open loaded work, with their done share and next due item. */
export function projectCards(
  rows: readonly WorkItemSummary[],
  projects: readonly ProjectSummary[],
): ProjectCard[] {
  return projects
    .map((project) => {
      const mine = rows.filter((row) => row.projectId === project.id);
      const done = mine.filter((row) => row.state === 'done').length;
      const openRows = mine.filter((row) => row.state !== 'done' && row.state !== 'archived');
      const next = openRows
        .filter((row) => row.dueAt !== null)
        .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))[0];
      return {
        project,
        percent: mine.length === 0 ? 0 : (done / mine.length) * 100,
        open: openRows.length,
        clientWaiting: openRows.filter((row) => row.audience === 'client_action_required').length,
        next,
      };
    })
    .filter((card) => card.open > 0)
    .sort((a, b) => b.open - a.open)
    .slice(0, 2)
    .map((card) => ({ ...card, percent: Math.round(card.percent) }));
}

function rowIcon(item: WorkItemSummary): PhoneIconName {
  if (item.state === 'done') return 'check';
  if (item.type === 'deliverable') return 'image';
  if (item.type === 'doc' || item.type === 'document') return 'file';
  return 'work';
}

/** "Thu 29 Oct" — the design's day, weekday first; Latin digits in Arabic, as elsewhere. */
function phoneDay(value: string, locale: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(
    appDateLocale(locale.toLowerCase().startsWith('ar') ? locale : 'en-GB'),
    {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    },
  );
}
