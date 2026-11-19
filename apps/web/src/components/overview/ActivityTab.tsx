'use client';

import Link from 'next/link';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { isClientRole, type ActivityKind } from '@tmanage/domain';
import { NavIcon } from '../icons/phone';
import {
  ActivityFeed,
  type ActivityFeedRow,
  type ActivityFeedState,
} from '../screens/ActivityFeed';
import { ActivityFilterMenu } from './ActivityFilterMenu';
import {
  ACTIVITY_PERIODS,
  NO_ACTIVITY_FILTERS,
  activityEntryHref,
  activityQueryFor,
  filterKindsFor,
  hasActivityFilters,
  type ActivityFilters,
  type ActivityPeriod,
} from './activity-tab-model';
import { clientViewHref, projectWorkHref } from './overview-links';
import { fillHoles } from './use-overview-copy';
import {
  listClientActivity,
  listProjectActivity,
  type ActivityEntry,
  type ActivityPage,
} from '../../lib/api/activity';
import type { ApiClient } from '../../lib/api/client';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useTOr } from '../../lib/i18n/use-t-or';
import { withIsolates } from '../../lib/i18n/with-isolates';

/**
 * Every word the Activity tab draws (the feed's own words are in `ActivityFeed`). The keys reach
 * the catalogues through the wiring step (B09-REPORT, WIRING); until then `tOr` returns the
 * English given here. An entry's sentence is the API's `phraseKey` (`activity.phrase.<action>`, or
 * `activity.subject.<action>` when it names its record, D2) with `{actor}` and `{subject}` filled,
 * each in a `<bdi>` (D10); its English fallback the API's `summary`.
 */
export const ACTIVITY_TAB_COPY = {
  'ActivityTab.tab': 'Activity',
  'ActivityTab.title': 'Activity',
  'ActivityTab.projectDescription': 'Every change on this project, newest first',
  'ActivityTab.clientDescription': "Every change across this client's projects, newest first",
  'ActivityTab.filtersLabel': 'Filter activity',
  'ActivityTab.kindLabel': 'Kind',
  'ActivityTab.all': 'All',
  'ActivityTab.kind.project': 'Project',
  'ActivityTab.kind.people': 'People',
  'ActivityTab.kind.work': 'Work',
  'ActivityTab.kind.time': 'Time',
  'ActivityTab.kind.files': 'Files',
  'ActivityTab.kind.approvals': 'Approvals',
  'ActivityTab.kind.milestones': 'Milestones',
  'ActivityTab.kind.requests': 'Requests',
  'ActivityTab.kind.money': 'Money',
  'ActivityTab.filter': 'Filter',
  'ActivityTab.person': 'Person',
  'ActivityTab.personChip': 'Person: {name}',
  'ActivityTab.anyone': 'Anyone',
  'ActivityTab.period': 'Date',
  'ActivityTab.period.any': 'Any time',
  'ActivityTab.period.7': 'Last 7 days',
  'ActivityTab.period.30': 'Last 30 days',
  'ActivityTab.period.90': 'Last 90 days',
  'ActivityTab.clearFilters': 'Clear filters',
  'ActivityTab.clientActor': '{name} (client)',
  /** D3: who a row with no person is by (an automation); drawn with the system orb. */
  'ActivityTab.system': 'TManage',
  'ActivityTab.noMatch': 'Nothing matches these filters.',
  'ActivityTab.emptyTitle': 'No activity yet',
  'ActivityTab.emptyProject':
    'Changes to work, files, approvals, time and money on this project show up here.',
  'ActivityTab.emptyProjectNoMoney':
    'Changes to work, files, approvals and time on this project show up here.',
  'ActivityTab.emptyClient': "Changes across this client's projects show up here.",
  'ActivityTab.goToWork': 'Go to work',
  'ActivityTab.openProjects': 'Open projects',
  'ActivityTab.startProject': 'Start a project',
} as const;

type TabCopyKey = keyof typeof ACTIVITY_TAB_COPY;

const PAGE_SIZE = 25;

/** A person the client page knows by name beyond the member directory (its client people). */
export interface ActivityPerson {
  readonly userId: string;
  readonly name: string;
  readonly client: boolean;
}

export type ActivityScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'client';
      readonly clientOrganizationId: string;
      /** Shared project names, for the meta line ("10:42 · Cedar Foods brand refresh · Work"). */
      readonly projectNames: ReadonlyMap<string, string>;
      readonly hasProjects: boolean;
      readonly people: readonly ActivityPerson[];
    };

export interface ActivityTabProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly scope: ActivityScope;
  readonly now: Date;
}

function scopeId(scope: ActivityScope): string {
  return scope.kind === 'project' ? scope.projectId : scope.clientOrganizationId;
}

/**
 * **62-A2 (B09) — the Activity tab** of the project page and the client page (FIGMA-D 753:41712,
 * filtered 753:42457, empty 753:43120; client 754:42228, empty 754:43001). One paged read
 * (`GET …/projects/:id/activity` or `…/client-organizations/:id/activity`, B02) drawn by the one
 * {@link ActivityFeed}; the kind chips, the Person and date menus and "Load more" only change what
 * that read asks for. The API already leaves out every entry the viewer could not open, money
 * entries included; the Money chip is offered only with finance access (review fix 1). Not in the
 * portal: both pages are internal.
 */
export function ActivityTab({ api, organizationSlug, scope, now }: ActivityTabProps) {
  const tOr = useTOr();
  const text = (key: TabCopyKey) => tOr(key, ACTIVITY_TAB_COPY[key]);
  const fill = (key: TabCopyKey, values: Readonly<Record<string, string>>) =>
    fillHoles(text(key), values);
  const [filters, setFilters] = useState<ActivityFilters>(NO_ACTIVITY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
  });
  const mayViewFinance = me.data?.capabilities.includes('finance.view') ?? false;
  const directory = useMembers(api, organizationSlug);

  const query = useMemo(() => activityQueryFor(filters, now), [filters, now]);
  const activity = useInfiniteQuery({
    queryKey: ['activity', organizationSlug, scope.kind, scopeId(scope), query],
    queryFn: ({ pageParam }): Promise<ActivityPage> => {
      const page = { ...query, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) };
      return scope.kind === 'project'
        ? listProjectActivity(api, organizationSlug, scope.projectId, page)
        : listClientActivity(api, organizationSlug, scope.clientOrganizationId, page);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const extraPeople = scope.kind === 'client' ? scope.people : [];
  const person = (userId: string): { name: string; client: boolean } => {
    const known = extraPeople.find((candidate) => candidate.userId === userId);
    if (known) return { name: known.name, client: known.client };
    const member = directory.members.find((candidate) => candidate.userId === userId);
    return {
      name: memberDisplayName(userId, directory.members, directory.isPending),
      client: member !== undefined && isClientRole(member.role),
    };
  };

  const kindLabel = (kind: ActivityKind) => text(`ActivityTab.kind.${kind}`);

  const row = (entry: ActivityEntry): ActivityFeedRow => {
    const actor = entry.actorUserId === null ? null : person(entry.actorUserId);
    const actorName =
      actor === null
        ? text('ActivityTab.system')
        : actor.client
          ? fill('ActivityTab.clientActor', { name: actor.name })
          : actor.name;
    const projectName =
      scope.kind === 'client' && entry.projectId !== null
        ? scope.projectNames.get(entry.projectId)
        : undefined;
    return {
      id: entry.id,
      occurredAt: entry.occurredAt,
      actor,
      // One sentence (D2): "Omar Adel changed the status of “Packaging artwork”".
      sentence: withIsolates(tOr(entry.phraseKey, entry.summary), {
        actor: actorName,
        ...(entry.subject === null ? {} : { subject: entry.subject }),
      }),
      meta: [...(projectName === undefined ? [] : [projectName]), kindLabel(entry.kind)],
      href: activityEntryHref(organizationSlug, entry),
    };
  };

  const filtered = hasActivityFilters(filters);
  const pages = activity.data?.pages ?? [];
  const state: ActivityFeedState = activity.isPending
    ? { status: 'loading' }
    : activity.isError && pages.length === 0
      ? { status: 'error', onRetry: () => void activity.refetch() }
      : { status: 'ready', rows: pages.flatMap((page) => page.entries.map(row)) };

  const personOptions = [
    { value: '', label: text('ActivityTab.anyone') },
    ...directory.members.map((member) => ({
      value: member.userId,
      label: person(member.userId).name,
    })),
    ...extraPeople
      .filter(
        (candidate) => !directory.members.some((member) => member.userId === candidate.userId),
      )
      .map((candidate) => ({ value: candidate.userId, label: candidate.name })),
  ];
  const personName =
    filters.person === null ? text('ActivityTab.anyone') : person(filters.person).name;

  return (
    <div className="tm-stack">
      <div className="tm-act-filters" role="group" aria-label={text('ActivityTab.filtersLabel')}>
        <KindChips
          label={text('ActivityTab.kindLabel')}
          allLabel={text('ActivityTab.all')}
          kinds={filterKindsFor(mayViewFinance).map((kind) => ({
            kind,
            label: kindLabel(kind),
          }))}
          value={filters.kind}
          onChange={(kind) => setFilters((current) => ({ ...current, kind }))}
        />
        <button
          type="button"
          className="tm-chip tm-act-filters__toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((current) => !current)}
        >
          {text('ActivityTab.filter')}
          <NavIcon name="chevronDown" size={16} />
        </button>
        <div className="tm-act-filters__more" data-open={filtersOpen}>
          <ActivityFilterMenu
            label={fill('ActivityTab.personChip', { name: personName })}
            menuLabel={text('ActivityTab.person')}
            options={personOptions}
            value={filters.person ?? ''}
            active={filters.person !== null}
            onChange={(value) =>
              setFilters((current) => ({ ...current, person: value === '' ? null : value }))
            }
          />
          <ActivityFilterMenu
            label={text(`ActivityTab.period.${filters.period}`)}
            menuLabel={text('ActivityTab.period')}
            options={ACTIVITY_PERIODS.map((period) => ({
              value: period,
              label: text(`ActivityTab.period.${period}`),
            }))}
            value={filters.period}
            active={filters.period !== 'any'}
            onChange={(value) =>
              setFilters((current) => ({ ...current, period: value as ActivityPeriod }))
            }
          />
          {filtered ? (
            <Button tone="text" size="accessible" onClick={() => setFilters(NO_ACTIVITY_FILTERS)}>
              {text('ActivityTab.clearFilters')}
            </Button>
          ) : null}
        </div>
      </div>

      <ActivityFeed
        title={text('ActivityTab.title')}
        description={text(
          scope.kind === 'project'
            ? 'ActivityTab.projectDescription'
            : 'ActivityTab.clientDescription',
        )}
        now={now}
        state={state}
        more={{
          hasMore: activity.hasNextPage,
          busy: activity.isFetchingNextPage,
          failed: activity.isFetchNextPageError,
          onMore: () => void activity.fetchNextPage(),
          ...(pages[0]?.total ? { total: pages[0].total } : {}),
        }}
        empty={
          filtered ? (
            <>
              <p>{text('ActivityTab.noMatch')}</p>
              <Button
                tone="outline"
                size="accessible"
                onClick={() => setFilters(NO_ACTIVITY_FILTERS)}
              >
                {text('ActivityTab.clearFilters')}
              </Button>
            </>
          ) : (
            <EmptyActivity
              organizationSlug={organizationSlug}
              scope={scope}
              mayViewFinance={mayViewFinance}
              text={text}
            />
          )
        }
      />
    </div>
  );
}

/** "No activity yet" (753:43120 / 754:43001), with the one next step that fits (review fix 7). */
function EmptyActivity({
  organizationSlug,
  scope,
  mayViewFinance,
  text,
}: {
  readonly organizationSlug: string;
  readonly scope: ActivityScope;
  readonly mayViewFinance: boolean;
  readonly text: (key: TabCopyKey) => string;
}) {
  const body =
    scope.kind === 'client'
      ? text('ActivityTab.emptyClient')
      : text(mayViewFinance ? 'ActivityTab.emptyProject' : 'ActivityTab.emptyProjectNoMoney');
  const action =
    scope.kind === 'project'
      ? {
          href: projectWorkHref(organizationSlug, scope.projectId),
          label: text('ActivityTab.goToWork'),
        }
      : scope.hasProjects
        ? {
            href: clientViewHref(organizationSlug, scope.clientOrganizationId, 'projects'),
            label: text('ActivityTab.openProjects'),
          }
        : { href: `/${organizationSlug}/projects/new`, label: text('ActivityTab.startProject') };
  return (
    <div className="tm-act-empty">
      <h3 className="tm-act-empty__title">{text('ActivityTab.emptyTitle')}</h3>
      <p className="tm-act-empty__body">{body}</p>
      <Link className="tm-button tm-button--outline tm-button--accessible" href={action.href}>
        {action.label}
      </Link>
    </div>
  );
}

/**
 * "All · Work · Files · Approvals · Time · Money" — one choice (`radiogroup`, review fix 4): the
 * chosen chip is tinted and carries the check icon; arrows move the choice, one tab stop.
 */
function KindChips({
  label,
  allLabel,
  kinds,
  value,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly kinds: readonly { readonly kind: ActivityKind; readonly label: string }[];
  readonly value: ActivityKind | null;
  readonly onChange: (kind: ActivityKind | null) => void;
}) {
  const choices: readonly { readonly kind: ActivityKind | null; readonly label: string }[] = [
    { kind: null, label: allLabel },
    ...kinds,
  ];
  const at = Math.max(
    0,
    choices.findIndex((choice) => choice.kind === value),
  );

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = event.key === 'ArrowDown' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const back = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (!forward && !back) return;
    event.preventDefault();
    const next = (at + (forward ? 1 : -1) + choices.length) % choices.length;
    onChange(choices[next]?.kind ?? null);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      className="tm-act-filters__kinds"
      role="radiogroup"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={onKey}
    >
      {choices.map((choice, index) => (
        <button
          key={choice.kind ?? 'all'}
          type="button"
          role="radio"
          aria-checked={index === at}
          tabIndex={index === at ? 0 : -1}
          className="tm-chip"
          onClick={() => onChange(choice.kind)}
        >
          {index === at ? <NavIcon name="check" size={16} /> : null}
          {choice.label}
        </button>
      ))}
    </div>
  );
}
