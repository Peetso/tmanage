'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, StatusDot, Tooltip } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listPlatformCompanies } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  listPlatformPeople,
  peopleQueryString,
  sendPlatformPersonPasswordReset,
  signOutPlatformPersonEverywhere,
} from '../../../lib/api/platform-people';
import type { PlatformPeopleQuery, PlatformPeopleRowView } from '../../../lib/api/platform-people';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { ReasonDialog } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import { relativeMoment } from '../team/PlatformTeamScreen';
import { isOnlineNow } from './presence';
import { BUILT_IN_ROLES, CLIENT_ROLES, daysAgoIso, shortDay } from './people-format';
import { roleName } from './PersonFrame';
import { withNumerals } from '../../../lib/i18n/display-format';

export const PLATFORM_PEOPLE_KEY = ['platform', 'people'] as const;

type T = ReturnType<typeof useT>;

/** The drawn defaults: active people, signed in during the last 30 days. */
const DEFAULT_FILTER: PlatformPeopleQuery = { status: 'active', signInFrom: daysAgoIso(30) };
const BROWSE_ALL: PlatformPeopleQuery = { status: 'any' };

/**
 * B1 · People — `/platform/people` (frames 434:14534 list, 434:14921 empty, 434:15036 error,
 * 438:18763 Arabic). Every person across every organization: search by name, email or user id,
 * seven filters, bulk sign-out and password reset, a disabled row muted with who and why.
 */
export function PeopleListScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [filter, setFilter] = useState<PlatformPeopleQuery>(DEFAULT_FILTER);
  return (
    <PlatformGate
      api={api}
      section="people"
      crumbs={[t('PlatformPeople.crumb')]}
      title={t('PlatformPeople.title')}
      description={t('PlatformPeople.description')}
      actions={() => (
        <span className="tm-cc-card__actions">
          <ExportCsvButton />
          <Button type="button" tone="ink" onClick={() => setFilter(BROWSE_ALL)}>
            {t('PlatformPeople.browseAll')}
          </Button>
        </span>
      )}
    >
      {(me) => <PeopleBody api={api} me={me} filter={filter} onFilter={setFilter} />}
    </PlatformGate>
  );
}

/** Export CSV is PA-09's Data exports (wave 3): drawn, present, and disabled until then. */
export function ExportCsvButton() {
  const t = useT();
  return (
    <Tooltip content={t('PlatformPeople.exportSoon')}>
      <button
        type="button"
        className="tm-button tm-button--outline tm-button--default"
        aria-disabled="true"
        style={{ opacity: 0.5, cursor: 'not-allowed' }}
      >
        {t('PlatformPeople.exportCsv')}
      </button>
    </Tooltip>
  );
}

type Bulk = 'sign-out' | 'reset';

function PeopleBody({
  api,
  me,
  filter,
  onFilter,
}: {
  api: ApiClient;
  me: PlatformMeView;
  filter: PlatformPeopleQuery;
  onFilter: (next: PlatformPeopleQuery) => void;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const [draft, setDraft] = useState(filter.q ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canSecure = me.permissions.includes('platform.people.security');

  const people = useInfiniteQuery({
    queryKey: [...PLATFORM_PEOPLE_KEY, peopleQueryString(filter)],
    queryFn: ({ pageParam }) =>
      listPlatformPeople(api, { ...filter, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const organizations = useQuery({
    queryKey: ['platform', 'people', 'organization-options'],
    queryFn: () => listPlatformCompanies(api),
  });

  const rows = useMemo(
    () => (people.data?.pages ?? []).flatMap((page) => page.people),
    [people.data],
  );
  const total = people.data?.pages[0]?.total ?? 0;
  const set = (next: PlatformPeopleQuery) => {
    setSelected(new Set());
    onFilter(next);
  };

  const filters = (
    <form
      noValidate
      className="tm-stack tm-stack--tight"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        set({ ...without(filter, 'q'), ...(draft.trim() ? { q: draft.trim() } : {}) });
      }}
    >
      <input
        type="search"
        className="tm-input"
        aria-label={t('PlatformPeople.searchLabel')}
        placeholder={t('PlatformPeople.searchPlaceholder')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" className="tm-visually-hidden">
        {t('PlatformPeople.searchLabel')}
      </button>
      <div className="tm-cc-card__actions" aria-label={t('PlatformPeople.filtersLabel')}>
        <FilterChip
          label={t('PlatformPeople.filterStatus')}
          value={filter.status ?? 'any'}
          onChange={(value) =>
            set({
              ...without(filter, 'status'),
              status: value as NonNullable<PlatformPeopleQuery['status']>,
            })
          }
          options={[
            ['any', t('PlatformPeople.any')],
            ['active', t('PlatformPeople.statusActive')],
            ['disabled', t('PlatformPeople.statusDisabled')],
          ]}
        />
        <FilterChip
          label={t('PlatformPeople.filterVerified')}
          value={boolValue(filter.verified)}
          onChange={(value) => set(boolPatch(filter, 'verified', value))}
          options={[
            ['any', t('PlatformPeople.any')],
            ['true', t('PlatformPeople.verified')],
            ['false', t('PlatformPeople.notVerified')],
          ]}
        />
        <FilterChip
          label={t('PlatformPeople.filterTwoStep')}
          value={boolValue(filter.mfa)}
          onChange={(value) => set(boolPatch(filter, 'mfa', value))}
          options={[
            ['any', t('PlatformPeople.any')],
            ['true', t('PlatformPeople.on')],
            ['false', t('PlatformPeople.off')],
          ]}
        />
        <FilterChip
          label={t('PlatformPeople.filterOrganization')}
          value={filter.organizationId ?? ''}
          onChange={(value) =>
            set({
              ...without(filter, 'organizationId'),
              ...(value ? { organizationId: value } : {}),
            })
          }
          options={[
            ['', t('PlatformPeople.any')],
            ...(organizations.data ?? []).map(
              (organization) => [organization.id, organization.name] as const,
            ),
          ]}
        />
        <FilterChip
          label={t('PlatformPeople.filterRole')}
          value={filter.role ?? ''}
          onChange={(value) =>
            set({ ...without(filter, 'role'), ...(value ? { role: value } : {}) })
          }
          options={[
            ['', t('PlatformPeople.any')],
            ...[...BUILT_IN_ROLES, ...CLIENT_ROLES].map(
              (role) => [role, roleText(t, role)] as const,
            ),
          ]}
        />
        <FilterChip
          label={t('PlatformPeople.filterSignedIn')}
          value={signInValue(filter.signInFrom)}
          onChange={(value) =>
            set({
              ...without(filter, 'signInFrom'),
              ...(value === 'any' ? {} : { signInFrom: daysAgoIso(Number(value)) }),
            })
          }
          options={[
            ['any', t('PlatformPeople.anyTime')],
            ['7', t('PlatformPeople.last7Days')],
            ['30', t('PlatformPeople.last30Days')],
            ['90', t('PlatformPeople.last90Days')],
          ]}
        />
        <label className={`tm-cc-pill${filter.hasSessions ? ' tm-cc-pill--on' : ''}`}>
          <input
            type="checkbox"
            className="tm-visually-hidden"
            checked={filter.hasSessions === true}
            onChange={(event) =>
              set({
                ...without(filter, 'hasSessions'),
                ...(event.target.checked ? { hasSessions: true } : {}),
              })
            }
          />
          {t('PlatformPeople.hasLiveSessions')}
        </label>
      </div>
    </form>
  );

  let body: ReactNode;
  if (people.isPending) {
    body = <PlatformPageState state="loading" loadingLabel={t('PlatformPeople.loading')} />;
  } else if (people.isError) {
    const missing = missingPlatformPermission(people.error);
    body =
      missing !== null ? (
        <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
      ) : (
        <PlatformPageState
          state="error"
          error={people.error}
          title={t('PlatformPeople.errorTitle')}
          onRetry={() => void people.refetch()}
        />
      );
  } else if (rows.length === 0) {
    body = (
      <section className="tm-cc-card tm-stack" aria-live="polite">
        <p className="tm-cc-eyebrow">{t('PlatformPeople.emptyEyebrow')}</p>
        <h2 className="tm-cc-card__title">
          {filter.q
            ? `${t('PlatformPeople.emptyTitleFor')} “${filter.q}”`
            : t('PlatformPeople.emptyTitle')}
        </h2>
        <p className="tm-cc-note">{t('PlatformPeople.emptyBody')}</p>
        <div className="tm-cc-card__actions">
          <Button
            type="button"
            tone="outline"
            onClick={() => {
              setDraft(filter.q ?? '');
              onFilter({ ...(filter.q ? { q: filter.q } : {}), status: 'any' });
            }}
          >
            {t('PlatformPeople.clearFilters')}
          </Button>
          <Button
            type="button"
            tone="ink"
            onClick={() => {
              setDraft('');
              onFilter(BROWSE_ALL);
            }}
          >
            {t('PlatformPeople.browseAllPeople')}
          </Button>
        </div>
      </section>
    );
  } else {
    body = (
      <PlatformTable<PlatformPeopleRowView>
        label={t('PlatformPeople.tableLabel')}
        rows={rows}
        rowKey={(row) => row.id}
        isMuted={(row) => row.status === 'disabled'}
        {...(canSecure ? { selected, onSelectedChange: setSelected } : {})}
        bulkActions={() => (
          <>
            <Button type="button" tone="outline" size="compact" onClick={() => setBulk('sign-out')}>
              {t('PlatformPeople.bulkSignOut')}
            </Button>
            <Button type="button" tone="outline" size="compact" onClick={() => setBulk('reset')}>
              {t('PlatformPeople.bulkReset')}
            </Button>
            <ExportCsvButton />
          </>
        )}
        hasMore={people.hasNextPage}
        loadingMore={people.isFetchingNextPage}
        onLoadMore={() => void people.fetchNextPage()}
        footer={`${t('PlatformPeople.showing')} 1–${rows.length} ${t('PlatformPeople.of')} ${total.toLocaleString(withNumerals(locale))} ${t('PlatformPeople.peopleWord')}`}
        columns={[
          {
            id: 'person',
            header: t('PlatformPeople.colPerson'),
            cell: (row) => (
              <Link href={`/platform/people/${row.id}`} className="tm-cc-card__actions">
                <Avatar name={row.displayName} size="compact" decorative />
                <span className="tm-cc-cell-title">{row.displayName}</span>
              </Link>
            ),
          },
          {
            id: 'email',
            header: t('PlatformPeople.colEmail'),
            cell: (row) => (
              <>
                <bdi dir="ltr">{row.email}</bdi>{' '}
                {row.emailVerified ? (
                  <span aria-label={t('PlatformPeople.verified')}>✓</span>
                ) : (
                  <span className="tm-cc-cell-sub">· {t('PlatformPeople.notVerifiedLower')}</span>
                )}
              </>
            ),
          },
          {
            id: 'organizations',
            header: t('PlatformPeople.colOrganizations'),
            cell: (row) => <OrgChips row={row} />,
          },
          {
            id: 'twoStep',
            header: t('PlatformPeople.colTwoStep'),
            cell: (row) =>
              row.mfaEnabled ? (
                <StatusDot tone="success">{t('PlatformPeople.on')}</StatusDot>
              ) : (
                <StatusDot tone="neutral">{t('PlatformPeople.off')}</StatusDot>
              ),
          },
          {
            id: 'lastSignIn',
            header: t('PlatformPeople.colLastSignIn'),
            cell: (row) => relativeMoment(row.lastSignInAt, locale),
          },
          {
            id: 'status',
            header: t('PlatformPeople.colStatus'),
            cell: (row) =>
              row.status === 'active' ? (
                isOnlineNow(row.lastActiveAt) ? (
                  <StatusDot tone="success">{t('PlatformPeople.onlineNow')}</StatusDot>
                ) : (
                  <StatusDot tone="neutral">
                    {row.lastActiveAt
                      ? `${t('PlatformPeople.lastSeen')} ${relativeMoment(row.lastActiveAt, locale)}`
                      : t('PlatformPeople.offline')}
                  </StatusDot>
                )
              ) : (
                <Tooltip content={disabledTooltip(t, row, locale)}>
                  <button type="button" className="tm-cc-pill tm-cc-pill--muted">
                    {t('PlatformPeople.statusDisabled')}
                  </button>
                </Tooltip>
              ),
          },
        ]}
      />
    );
  }

  const chosen = rows.filter((row) => selected.has(row.id));
  return (
    <div className="tm-stack">
      {filters}
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      {body}
      {bulk !== null ? (
        <ReasonDialog
          title={
            bulk === 'sign-out'
              ? `${t('PlatformPeople.bulkSignOutTitle')} ${chosen.length} ${t('PlatformPeople.peopleWord')}?`
              : `${t('PlatformPeople.bulkResetTitle')} ${chosen.length} ${t('PlatformPeople.peopleWord')}?`
          }
          body={
            bulk === 'sign-out' ? t('PlatformPeople.signOutBody') : t('PlatformPeople.resetBody')
          }
          reasonRequired
          destructive={bulk === 'sign-out'}
          confirmLabel={
            bulk === 'sign-out' ? t('PlatformPeople.bulkSignOut') : t('PlatformPeople.bulkReset')
          }
          onConfirm={async (reason) => {
            for (const row of chosen) {
              if (bulk === 'sign-out') {
                await signOutPlatformPersonEverywhere(api, row.id, reason ?? '');
              } else {
                await sendPlatformPersonPasswordReset(api, row.id, reason ?? '');
              }
            }
            setNotice(
              `${bulk === 'sign-out' ? t('PlatformPeople.bulkSignedOut') : t('PlatformPeople.bulkResetSent')} ${chosen.length} ${t('PlatformPeople.peopleWord')}.`,
            );
            setSelected(new Set());
            await people.refetch();
          }}
          onClose={() => setBulk(null)}
        />
      ) : null}
    </div>
  );
}

/** The ORGANIZATIONS cell: two chips, then "+N"; a client membership is the purple chip. */
function OrgChips({ row }: { row: PlatformPeopleRowView }) {
  const t = useT();
  const shown = row.companies.slice(0, 2);
  const more = row.companies.length - shown.length;
  if (row.companies.length === 0) return <span className="tm-cc-cell-sub">—</span>;
  return (
    <span className="tm-cc-card__actions">
      {shown.map((company) => (
        <span
          key={`${company.audience}:${company.id}`}
          className={`tm-cc-pill${company.audience === 'client' ? ' tm-cc-pill--client' : ''}`}
        >
          {company.name}
          {company.audience === 'client' ? ` · ${t('PlatformPeople.client')}` : ''}
        </span>
      ))}
      {more > 0 ? <span className="tm-cc-pill tm-cc-pill--muted">+{more}</span> : null}
    </span>
  );
}

function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="tm-cc-pill">
      <span>{label}:</span>
      <select
        className="tm-cc-select-inline"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ border: 0, background: 'transparent', font: 'inherit', color: 'inherit' }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function disabledTooltip(t: T, row: PlatformPeopleRowView, locale: string): string {
  const by = row.disabledByEmail ? ` ${t('PlatformPeople.by')} ${row.disabledByEmail}` : '';
  const reason = row.disabledReason
    ? ` / ${t('PlatformPeople.reason')}: “${row.disabledReason}”`
    : '';
  return `${t('PlatformPeople.disabledOn')} ${shortDay(row.disabledAt, locale)}${by}${reason}`;
}

export function roleText(t: T, role: string): string {
  return roleName(t, role, null);
}

function boolValue(value: boolean | undefined): string {
  return value === undefined ? 'any' : String(value);
}

function boolPatch(
  filter: PlatformPeopleQuery,
  key: 'verified' | 'mfa',
  value: string,
): PlatformPeopleQuery {
  const rest = without(filter, key);
  return value === 'any' ? rest : { ...rest, [key]: value === 'true' };
}

function signInValue(from: string | undefined): string {
  if (!from) return 'any';
  const days = Math.round((Date.now() - new Date(from).getTime()) / 86_400_000);
  if (days <= 8) return '7';
  if (days <= 31) return '30';
  return '90';
}

function without<K extends keyof PlatformPeopleQuery>(
  filter: PlatformPeopleQuery,
  key: K,
): Omit<PlatformPeopleQuery, K> {
  const { [key]: _drop, ...rest } = filter;
  return rest;
}
