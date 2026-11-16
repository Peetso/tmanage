'use client';

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  DateField,
  InlineAlert,
  LoadingRegion,
  SearchField,
  Select,
  Skeleton,
  StateCapsule,
  Tooltip,
  VisuallyHidden,
} from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import {
  PUBLIC_LINK_MAX_EXPIRY_DAYS,
  publicLinkIsLive,
  type PublicLinkManagedStatus,
  type PublicLinkStateFilter,
} from '@tmanage/domain';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  changePublicLinkExpiry,
  fetchPublicLinkManager,
  publicLinkManagerKey,
  revokePublicLink,
  revokePublicLinks,
} from '../../lib/api/public-link-manager';
import type {
  ManagedPublicLinkView,
  PublicLinkManagerQuery,
} from '../../lib/api/public-link-manager';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { fill } from '../people/ChangeRoleDialog';
import { PhoneIcon } from '../icons/phone/PhoneIcon';
import '../../styles/screens/people.css';
import '../../styles/screens/public-links.css';

/**
 * 56-07p · **Settings · Public links** — Figma section 619:35203: list 619:35204, empty 620:35336,
 * revoke confirm 620:35653, change expiry 620:35678, phone 622:35515, Arabic 621:35354.
 *
 * Every link the workspace issued that opens without signing in (approvals and quotes — the
 * kinds a member really issues), what it opens, who made it and when, when it ends, when it was
 * last opened and how often. An owner or admin revokes one or many and moves their end. The API
 * decides who may see this page (`org.security.manage`) and never sends a token or its hint.
 * An ended, answered or revoked link has nothing to revoke: its box is disabled and its menu
 * offers only "Open what it shows".
 */

type Translate = (key: string, english: string) => string;

const STATUS: Record<PublicLinkManagedStatus, readonly [CapsuleState, string, string]> = {
  active: ['current', 'PublicLinks.status.active', 'Active'],
  ending_soon: ['waiting', 'PublicLinks.status.endingSoon', 'Ending soon'],
  used: ['done', 'PublicLinks.status.used', 'Used'],
  answered: ['done', 'PublicLinks.status.answered', 'Answered'],
  expired: ['archived', 'PublicLinks.status.expired', 'Expired'],
  revoked: ['blocked', 'PublicLinks.status.revoked', 'Revoked'],
};

const KIND: Record<ManagedPublicLinkView['kind'], readonly [string, string]> = {
  approval: ['PublicLinks.kind.approval', 'Approval'],
  quote: ['PublicLinks.kind.quote', 'Quote'],
  intake: ['PublicLinks.kind.intake', 'Request form'],
  share: ['PublicLinks.kind.share', 'Shared view'],
  magic_signin: ['PublicLinks.kind.magicSignin', 'Sign-in link'],
};

/** Where each kind comes from, for the empty state. */
const KIND_HINT: Partial<Record<ManagedPublicLinkView['kind'], readonly [string, string]>> = {
  approval: ['PublicLinks.empty.hintApproval', 'From a design, choose Send for approval'],
  quote: ['PublicLinks.empty.hintQuote', 'From a quote, choose Share with client'],
};

const DAY_MS = 86_400_000;

export interface AdminPublicLinksScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests. Defaults to the wall clock. */
  now?: () => Date;
}

type Dialog =
  | { readonly kind: 'revoke'; readonly links: readonly ManagedPublicLinkView[] }
  | { readonly kind: 'expiry'; readonly links: readonly ManagedPublicLinkView[] };

export function AdminPublicLinksScreen({
  organizationSlug,
  organizationName,
  client,
  now = () => new Date(),
}: AdminPublicLinksScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [state, setState] = useState<PublicLinkStateFilter>('active');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const deferredSearch = useDeferredValue(search);
  const query: PublicLinkManagerQuery = { search: deferredSearch, kind, createdBy, state, page };

  const links = useQuery({
    queryKey: publicLinkManagerKey(organizationSlug, query),
    queryFn: () => fetchPublicLinkManager(api, organizationSlug, query),
  });
  const view = links.data;
  const rows = view?.links ?? [];
  const live = rows.filter((row) => publicLinkIsLive(row.status));
  const chosen = live.filter((row) => selected.has(row.id));
  const filtered = search.trim() !== '' || kind !== '' || createdBy !== '';
  const nothingIssued =
    view !== undefined &&
    !filtered &&
    view.counts.active + view.counts.ended === 0 &&
    view.total === 0;

  // A new page, filter or state starts with nothing selected.
  useEffect(() => setSelected(new Set()), [deferredSearch, kind, createdBy, state, page]);

  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const closeDialog = async (message: string | null) => {
    setDialog(null);
    if (message === null) return;
    setNotice(message);
    setSelected(new Set());
    await queryClient.invalidateQueries({ queryKey: publicLinkManagerKey(organizationSlug) });
  };

  const description =
    view === undefined || nothingIssued
      ? tOr('PublicLinks.description', 'Links that open without signing in')
      : fill(
          tOr(
            'PublicLinks.descriptionCounts',
            'Links that open without signing in · {active} active · {soon} end soon',
          ),
          { active: String(view.counts.active), soon: String(view.counts.endingSoon) },
        );

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="public-links"
      crumbs={[tOr('PublicLinks.title', 'Public links')]}
      title={tOr('PublicLinks.title', 'Public links')}
      description={description}
      client={api}
    >
      <p className="tm-visually-hidden" role="status">
        {notice}
      </p>

      {links.isPending ? (
        <LoadingRegion label={tOr('PublicLinks.loading', 'Loading public links')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {links.isError ? (
        <InlineAlert tone="danger" title={tOr('PublicLinks.loadError', 'Links did not load')} live>
          {describe(links.error)}
        </InlineAlert>
      ) : null}

      {view !== undefined && nothingIssued ? (
        <EmptyState organizationSlug={organizationSlug} kinds={view.kinds} tOr={tOr} />
      ) : null}

      {view !== undefined && !nothingIssued ? (
        <>
          <div className="pl-filters" role="search">
            <SearchField
              label={tOr('PublicLinks.search', 'Search links or people')}
              placeholder={tOr('PublicLinks.search', 'Search links or people')}
              value={search}
              onChange={(event) => refilter(() => setSearch(event.currentTarget.value))}
            />
            <div
              className="tm-chip-row"
              role="group"
              aria-label={tOr('PublicLinks.stateGroup', 'Show')}
            >
              <StateChip
                label={tOr('PublicLinks.chip.active', 'Active')}
                count={view.counts.active}
                pressed={state === 'active'}
                onPress={() => refilter(() => setState(state === 'active' ? 'all' : 'active'))}
              />
              <StateChip
                label={tOr('PublicLinks.chip.endingSoon', 'Ending soon')}
                count={view.counts.endingSoon}
                pressed={state === 'ending_soon'}
                onPress={() =>
                  refilter(() => setState(state === 'ending_soon' ? 'all' : 'ending_soon'))
                }
              />
              <StateChip
                label={tOr('PublicLinks.chip.ended', 'Ended')}
                count={view.counts.ended}
                pressed={state === 'ended'}
                onPress={() => refilter(() => setState(state === 'ended' ? 'all' : 'ended'))}
              />
            </div>
            <div className="pl-filters__end">
              <Select
                label={tOr('PublicLinks.filterKind', 'Kind')}
                value={kind}
                onChange={(event) => refilter(() => setKind(event.currentTarget.value))}
              >
                <option value="">{tOr('PublicLinks.allKinds', 'All kinds')}</option>
                {view.kinds.map((k) => (
                  <option key={k} value={k}>
                    {tOr(KIND[k][0], KIND[k][1])}
                  </option>
                ))}
              </Select>
              <Select
                label={tOr('PublicLinks.filterCreatedBy', 'Created by')}
                value={createdBy}
                onChange={(event) => refilter(() => setCreatedBy(event.currentTarget.value))}
              >
                <option value="">{tOr('PublicLinks.anyone', 'Anyone')}</option>
                {view.creators.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {chosen.length > 0 ? (
            <div
              className="pl-bulk"
              role="region"
              aria-label={tOr('PublicLinks.bulkLabel', 'Selected links')}
            >
              <span className="pl-bulk__count">
                {fill(tOr('PublicLinks.selected', '{count} links selected'), {
                  count: String(chosen.length),
                })}
              </span>
              <Button type="button" tone="text" onClick={() => setSelected(new Set())}>
                {tOr('PublicLinks.clearSelection', 'Clear selection')}
              </Button>
              <span className="pl-bulk__actions">
                <Button
                  type="button"
                  tone="outline"
                  onClick={() => setDialog({ kind: 'expiry', links: chosen })}
                >
                  {tOr('PublicLinks.changeExpiry', 'Change expiry')}
                </Button>
                <Button
                  type="button"
                  tone="destructive"
                  onClick={() => setDialog({ kind: 'revoke', links: chosen })}
                >
                  {fill(tOr('PublicLinks.revokeMany', 'Revoke {count} links'), {
                    count: String(chosen.length),
                  })}
                </Button>
              </span>
            </div>
          ) : null}

          <LinkTable
            organizationSlug={organizationSlug}
            rows={rows}
            selected={selected}
            now={now()}
            onToggle={(id, on) =>
              setSelected((current) => {
                const next = new Set(current);
                if (on) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onToggleAll={(on) => setSelected(on ? new Set(live.map((row) => row.id)) : new Set())}
            onChangeExpiry={(row) => setDialog({ kind: 'expiry', links: [row] })}
            onRevoke={(row) => setDialog({ kind: 'revoke', links: [row] })}
          />

          {rows.length === 0 ? (
            <p className="pl-none">{tOr('PublicLinks.noMatch', 'No links match these filters.')}</p>
          ) : (
            <Pager page={view.page} pageSize={view.pageSize} total={view.total} onPage={setPage} />
          )}

          <p className="pl-footnote">
            {tOr(
              'PublicLinks.footnote',
              'Revoking a link stops it at once. Anyone who opens it after that sees a short note that it is no longer available. Every change is kept in the audit log.',
            )}
          </p>
        </>
      ) : null}

      {dialog?.kind === 'revoke' ? (
        <RevokeDialog
          api={api}
          organizationSlug={organizationSlug}
          links={dialog.links}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'expiry' ? (
        <ExpiryDialog
          api={api}
          organizationSlug={organizationSlug}
          links={dialog.links}
          today={now()}
          onClose={closeDialog}
        />
      ) : null}
    </ControlCenterShell>
  );
}

function StateChip({
  label,
  count,
  pressed,
  onPress,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={pressed ? 'tm-chip tm-chip--active pl-chip' : 'tm-chip pl-chip'}
      aria-pressed={pressed}
      onClick={onPress}
    >
      {label}
      <span className="pl-chip__count">{count}</span>
    </button>
  );
}

function EmptyState({
  organizationSlug,
  kinds,
  tOr,
}: {
  organizationSlug: string;
  kinds: readonly ManagedPublicLinkView['kind'][];
  tOr: Translate;
}) {
  const headingId = useId();
  return (
    <section className="pl-empty" aria-labelledby={headingId}>
      <span className="pl-empty__icon" aria-hidden="true">
        <PhoneIcon name="lock" size={20} />
      </span>
      <h2 id={headingId} className="pl-empty__title">
        {tOr('PublicLinks.empty.title', 'No public links yet')}
      </h2>
      <p className="pl-empty__body">
        {tOr(
          'PublicLinks.empty.body',
          'When you send a client something to approve or a quote, its link appears here. You can see when it was opened, change when it ends, or switch it off at any time.',
        )}
      </p>
      <ul className="pl-empty__hints">
        {kinds.map((k) => {
          const hint = KIND_HINT[k];
          return hint === undefined ? null : (
            <li key={k} className="pl-empty__hint">
              <strong>{tOr(KIND[k][0], KIND[k][1])}</strong>
              <span>{tOr(hint[0], hint[1])}</span>
            </li>
          );
        })}
      </ul>
      <a className="tm-button tm-button--outline" href={`/${organizationSlug}/projects`}>
        {tOr('PublicLinks.empty.cta', 'Go to projects')}
      </a>
    </section>
  );
}

function useDates() {
  const locale = useActiveLocale();
  const short = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(iso));
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  return { short, time };
}

function daysUntil(iso: string, now: Date): number {
  return Math.max(1, Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS));
}

function LinkTable({
  organizationSlug,
  rows,
  selected,
  now,
  onToggle,
  onToggleAll,
  onChangeExpiry,
  onRevoke,
}: {
  organizationSlug: string;
  rows: readonly ManagedPublicLinkView[];
  selected: ReadonlySet<string>;
  now: Date;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onChangeExpiry: (row: ManagedPublicLinkView) => void;
  onRevoke: (row: ManagedPublicLinkView) => void;
}) {
  const tOr = useTOr();
  const headingId = useId();
  const live = rows.filter((row) => publicLinkIsLive(row.status));
  const picked = live.filter((row) => selected.has(row.id)).length;
  if (rows.length === 0) return null;
  return (
    <div className="ppl-members-card pl-card">
      <h2 id={headingId} className="tm-visually-hidden">
        {tOr('PublicLinks.title', 'Public links')}
      </h2>
      <table className="ppl-members pl-table" aria-labelledby={headingId}>
        <thead>
          <tr>
            <th scope="col" className="pl-check">
              <Checkbox
                label={
                  <VisuallyHidden>
                    {tOr('PublicLinks.selectAll', 'Select all on this page')}
                  </VisuallyHidden>
                }
                checked={live.length > 0 && picked === live.length}
                indeterminate={picked > 0 && picked < live.length}
                disabled={live.length === 0}
                onChange={(event) => onToggleAll(event.currentTarget.checked)}
              />
            </th>
            <th scope="col">{tOr('PublicLinks.col.link', 'Link')}</th>
            <th scope="col">{tOr('PublicLinks.col.kind', 'Kind')}</th>
            <th scope="col">{tOr('PublicLinks.col.createdBy', 'Created by')}</th>
            <th scope="col">{tOr('PublicLinks.col.expires', 'Expires')}</th>
            <th scope="col">{tOr('PublicLinks.col.lastOpened', 'Last opened')}</th>
            <th scope="col">{tOr('PublicLinks.col.state', 'State')}</th>
            <th scope="col">
              <span className="tm-visually-hidden">
                {tOr('PublicLinks.col.actions', 'Actions')}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <LinkRow
              key={row.id}
              organizationSlug={organizationSlug}
              row={row}
              now={now}
              checked={selected.has(row.id)}
              onToggle={(on) => onToggle(row.id, on)}
              onChangeExpiry={() => onChangeExpiry(row)}
              onRevoke={() => onRevoke(row)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function linkTitle(row: ManagedPublicLinkView, tOr: Translate): string {
  return row.title ?? tOr('PublicLinks.removedItem', 'An item that was removed');
}

function openHref(organizationSlug: string, row: ManagedPublicLinkView): string | null {
  if (row.opens === null) return null;
  const org = encodeURIComponent(organizationSlug);
  return 'quoteId' in row.opens
    ? `/${org}/quotes/${encodeURIComponent(row.opens.quoteId)}`
    : `/${org}/projects/${encodeURIComponent(row.opens.projectId)}/deliverables/${encodeURIComponent(row.opens.deliverableId)}`;
}

function LinkRow({
  organizationSlug,
  row,
  now,
  checked,
  onToggle,
  onChangeExpiry,
  onRevoke,
}: {
  organizationSlug: string;
  row: ManagedPublicLinkView;
  now: Date;
  checked: boolean;
  onToggle: (on: boolean) => void;
  onChangeExpiry: () => void;
  onRevoke: () => void;
}) {
  const tOr = useTOr();
  const { short, time } = useDates();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const isLive = publicLinkIsLive(row.status);
  const title = linkTitle(row, tOr);
  const href = openHref(organizationSlug, row);
  const [capsule, statusKey, statusEnglish] = STATUS[row.status];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const lastOpened = (() => {
    if (row.lastOpenedAt === null) return tOr('PublicLinks.notOpened', 'Not opened yet');
    const days = Math.floor((now.getTime() - new Date(row.lastOpenedAt).getTime()) / DAY_MS);
    if (short(row.lastOpenedAt) === short(now.toISOString())) {
      return fill(tOr('PublicLinks.todayAt', 'Today, {time}'), { time: time(row.lastOpenedAt) });
    }
    return days <= 1 ? tOr('PublicLinks.yesterday', 'Yesterday') : short(row.lastOpenedAt);
  })();

  return (
    <tr className={['ppl-member', 'pl-row', checked ? 'pl-row--selected' : ''].join(' ')}>
      <td className="pl-check">
        <Checkbox
          label={
            <VisuallyHidden>
              {fill(tOr('PublicLinks.selectOne', 'Select {title}'), { title })}
            </VisuallyHidden>
          }
          checked={checked}
          disabled={!isLive}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
      </td>
      <td>
        <span className="ppl-member__name pl-title">{title}</span>
        <span className="pl-sub">
          {row.audienceEmail === null ? (
            tOr('PublicLinks.anyoneWithLink', 'Anyone with the link')
          ) : (
            <>
              {tOr('PublicLinks.forPrefix', 'For')} <bdi>{row.audienceEmail}</bdi>
            </>
          )}
        </span>
      </td>
      <td>
        <Badge>{tOr(KIND[row.kind][0], KIND[row.kind][1])}</Badge>
      </td>
      <td>
        <span className="pl-main">
          <bdi>{row.createdByName ?? tOr('PublicLinks.formerMember', 'A former member')}</bdi>
        </span>
        <span className="pl-sub">{short(row.createdAt)}</span>
      </td>
      <td>
        {row.status === 'revoked' && row.revokedAt !== null ? (
          <>
            <span className="pl-main">
              {fill(tOr('PublicLinks.revokedOn', 'Revoked {date}'), { date: short(row.revokedAt) })}
            </span>
            {row.revokedByName !== null ? (
              <span className="pl-sub">
                {tOr('PublicLinks.byPrefix', 'by')} <bdi>{row.revokedByName}</bdi>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="pl-main">{short(row.expiresAt)}</span>
            {isLive ? (
              <span className={row.status === 'ending_soon' ? 'pl-sub pl-sub--warn' : 'pl-sub'}>
                {fill(tOr('PublicLinks.inDays', 'in {days} days'), {
                  days: String(daysUntil(row.expiresAt, now)),
                })}
              </span>
            ) : null}
          </>
        )}
      </td>
      <td>
        <span className="pl-main">{lastOpened}</span>
        {row.openCount > 0 ? (
          <span className="pl-sub">
            {fill(tOr('PublicLinks.opens', '{count} opens'), { count: String(row.openCount) })}
          </span>
        ) : null}
      </td>
      <td>
        <StateCapsule state={capsule}>{tOr(statusKey, statusEnglish)}</StateCapsule>
      </td>
      <td className="ppl-member__actions">
        {isLive || href !== null ? (
          <Tooltip
            content={tOr('PublicLinks.moreHelp', 'More actions for this link')}
            delayMs={600}
          >
            <button
              ref={triggerRef}
              type="button"
              className="ppl-kebab"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              aria-label={fill(tOr('PublicLinks.rowActions', 'Actions for {title}'), { title })}
              onClick={() => setOpen((value) => !value)}
            >
              <span aria-hidden="true">•••</span>
            </button>
          </Tooltip>
        ) : null}
        {open ? (
          <ul ref={menuRef} id={menuId} role="menu" className="ppl-row-menu">
            {isLive ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="ppl-row-menu__item"
                  onClick={choose(onChangeExpiry)}
                >
                  {tOr('PublicLinks.changeExpiry', 'Change expiry')}
                </button>
              </li>
            ) : null}
            {href !== null ? (
              <li role="none">
                <a role="menuitem" className="ppl-row-menu__item" href={href}>
                  {tOr('PublicLinks.openTarget', 'Open what it shows')}
                </a>
              </li>
            ) : null}
            {isLive ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="ppl-row-menu__item ppl-row-menu__item--danger"
                  onClick={choose(onRevoke)}
                >
                  {tOr('PublicLinks.revokeOne', 'Revoke link')}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const tOr = useTOr();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="pl-pager" aria-label={tOr('PublicLinks.pages', 'Pages')}>
      <span className="pl-pager__total">
        {fill(tOr('PublicLinks.showing', 'Showing {first}–{last} of {total}'), {
          first: String(first),
          last: String(last),
          total: String(total),
        })}
      </span>
      <button
        type="button"
        className="pl-pager__step"
        disabled={page <= 1}
        aria-label={tOr('PublicLinks.previousPage', 'Previous page')}
        onClick={() => onPage(page - 1)}
      >
        <span aria-hidden="true" className="pl-pager__arrow pl-pager__arrow--back" />
      </button>
      {Array.from({ length: pages }, (_, index) => index + 1).map((n) => (
        <button
          key={n}
          type="button"
          className="pl-pager__page"
          aria-current={n === page ? 'page' : undefined}
          onClick={() => onPage(n)}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        className="pl-pager__step"
        disabled={page >= pages}
        aria-label={tOr('PublicLinks.nextPage', 'Next page')}
        onClick={() => onPage(page + 1)}
      >
        <span aria-hidden="true" className="pl-pager__arrow" />
      </button>
    </nav>
  );
}

/** Focus the first control on open; Escape closes. */
function useDialogChrome(onClose: () => void) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input:not([disabled]), button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return panelRef;
}

function LinkCards({ links }: { links: readonly ManagedPublicLinkView[] }) {
  const tOr = useTOr();
  const { short } = useDates();
  return (
    <ul className="pl-cards">
      {links.map((row) => (
        <li key={row.id} className="ppl-current pl-cards__item">
          <span>
            <span className="ppl-current__name">{linkTitle(row, tOr)}</span>
            <span className="ppl-current__role">
              {tOr(KIND[row.kind][0], KIND[row.kind][1])}
              {row.audienceEmail !== null ? (
                <>
                  {' · '}
                  {tOr('PublicLinks.forPrefix', 'For').toLowerCase()} <bdi>{row.audienceEmail}</bdi>
                </>
              ) : null}
              {' · '}
              {fill(tOr('PublicLinks.ends', 'ends {date}'), { date: short(row.expiresAt) })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Figma 620:35653 — "Revoke 2 links?" with the red confirm. */
function RevokeDialog({
  api,
  organizationSlug,
  links,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  links: readonly ManagedPublicLinkView[];
  onClose: (message: string | null) => void;
}) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const titleId = useId();
  const panelRef = useDialogChrome(() => onClose(null));
  const one = links.length === 1;
  const count = String(links.length);
  const revoke = useMutation({
    mutationFn: async () => {
      const [only] = links;
      if (one && only !== undefined) {
        await revokePublicLink(api, organizationSlug, only.id);
        return 1;
      }
      return (
        await revokePublicLinks(
          api,
          organizationSlug,
          links.map((row) => row.id),
        )
      ).changed;
    },
    onSuccess: (changed) =>
      onClose(
        fill(tOr('PublicLinks.revokedNotice', '{count} links revoked.'), {
          count: String(changed),
        }),
      ),
  });
  return (
    <div className="ppl-dialog-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ppl-dialog"
      >
        <h2 id={titleId} className="ppl-dialog__title">
          {one
            ? tOr('PublicLinks.revokeTitleOne', 'Revoke this link?')
            : fill(tOr('PublicLinks.revokeTitle', 'Revoke {count} links?'), { count })}
        </h2>
        <div className="ppl-dialog__form">
          <p className="ppl-dialog__lede">
            {tOr(
              'PublicLinks.revokeLede',
              'Anyone who opens these links will see that they are no longer available. To share again, send a new link from the item.',
            )}
          </p>
          <LinkCards links={links} />
          <p className="ppl-dialog__hint">
            {tOr(
              'PublicLinks.revokeHint',
              'Nothing else changes. The audit log records who revoked them.',
            )}
          </p>
          {revoke.isError ? (
            <InlineAlert tone="danger" live>
              {describe(revoke.error)}
            </InlineAlert>
          ) : null}
          <div className="ppl-dialog__actions">
            <Button type="button" tone="outline" onClick={() => onClose(null)}>
              {tOr('PublicLinks.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              tone="destructive"
              loading={revoke.isPending}
              loadingLabel={tOr('PublicLinks.revoking', 'Revoking…')}
              onClick={() => {
                if (!revoke.isPending) revoke.mutate();
              }}
            >
              {one
                ? tOr('PublicLinks.revokeOne', 'Revoke link')
                : fill(tOr('PublicLinks.revokeMany', 'Revoke {count} links'), { count })}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** `'YYYY-MM-DD'` of a local date. */
function dayString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The end of a calendar day in the reader's own time zone, as an instant. */
export function endOfDayInstant(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** Figma 620:35678 — "Change expiry for 2 links": a date picker and three quick choices. */
function ExpiryDialog({
  api,
  organizationSlug,
  links,
  today,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  links: readonly ManagedPublicLinkView[];
  today: Date;
  onClose: (message: string | null) => void;
}) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const titleId = useId();
  const panelRef = useDialogChrome(() => onClose(null));
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const choices: readonly (readonly [string, string, string])[] = [
    ['PublicLinks.quick7', 'In 7 days', dayString(addDays(today, 7))],
    ['PublicLinks.quickMonthEnd', 'End of this month', dayString(endOfMonth)],
    ['PublicLinks.quick30', 'In 30 days', dayString(addDays(today, PUBLIC_LINK_MAX_EXPIRY_DAYS))],
  ];
  const [day, setDay] = useState(choices[1]?.[2] ?? '');
  const min = dayString(today);
  const max = dayString(addDays(today, PUBLIC_LINK_MAX_EXPIRY_DAYS));
  const valid = day !== '' && day >= min && day <= max;
  const save = useMutation({
    mutationFn: () =>
      changePublicLinkExpiry(
        api,
        organizationSlug,
        links.map((row) => row.id),
        endOfDayInstant(day),
      ),
    onSuccess: (result) =>
      onClose(
        fill(tOr('PublicLinks.expiryNotice', 'New expiry saved for {count} links.'), {
          count: String(result.changed),
        }),
      ),
  });
  const one = links.length === 1;
  return (
    <div className="ppl-dialog-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ppl-dialog"
      >
        <h2 id={titleId} className="ppl-dialog__title">
          {one
            ? tOr('PublicLinks.expiryTitleOne', 'Change expiry for this link')
            : fill(tOr('PublicLinks.expiryTitle', 'Change expiry for {count} links'), {
                count: String(links.length),
              })}
        </h2>
        <form
          className="ppl-dialog__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !save.isPending) save.mutate();
          }}
        >
          <p className="ppl-dialog__lede">
            {tOr(
              'PublicLinks.expiryLede',
              'Choose a new last day. Links that have already ended stay ended.',
            )}
          </p>
          <DateField
            label={tOr('PublicLinks.expiryField', 'New expiry date')}
            hint={tOr('PublicLinks.expiryHint', 'The links stop working at the end of this day.')}
            error={
              day !== '' && !valid
                ? fill(tOr('PublicLinks.expiryRange', 'Choose a day in the next {days} days.'), {
                    days: String(PUBLIC_LINK_MAX_EXPIRY_DAYS),
                  })
                : undefined
            }
            value={day}
            min={min}
            max={max}
            required
            onValueChange={setDay}
          />
          <div
            className="tm-chip-row"
            role="group"
            aria-label={tOr('PublicLinks.quickLabel', 'Quick choices')}
          >
            {choices.map(([key, english, value]) => (
              <button
                key={key}
                type="button"
                className={day === value ? 'tm-chip tm-chip--active pl-chip' : 'tm-chip pl-chip'}
                aria-pressed={day === value}
                onClick={() => setDay(value)}
              >
                {tOr(key, english)}
              </button>
            ))}
          </div>
          <p className="ppl-dialog__hint">
            {tOr('PublicLinks.expiryAudit', 'The audit log records this change.')}
          </p>
          {save.isError ? (
            <InlineAlert tone="danger" live>
              {describe(save.error)}
            </InlineAlert>
          ) : null}
          <div className="ppl-dialog__actions">
            <Button type="button" tone="outline" onClick={() => onClose(null)}>
              {tOr('PublicLinks.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              disabled={!valid}
              loading={save.isPending}
              loadingLabel={tOr('PublicLinks.saving', 'Saving…')}
            >
              {tOr('PublicLinks.saveExpiry', 'Save expiry')}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
