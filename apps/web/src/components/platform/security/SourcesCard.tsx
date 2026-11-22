'use client';

import type { KeyboardEvent } from 'react';
import { Button, InlineAlert, SearchField, Skeleton, StateCapsule } from '@tmanage/ui';
import { TRACK_FILTERS } from '../../../lib/api/platform-security';
import type { TrackFilter, TrackPage, TrackSummary } from '../../../lib/api/platform-security';
import { useT } from '../../../lib/i18n/use-t';
import { useMenuPopup } from '../../overview/use-menu-popup';
import {
  FILTER_LABEL,
  NETWORK_LABEL,
  PERIOD_QUIET,
  SEVERITY_CAPSULE,
  SEVERITY_LABEL,
  allowlistAction,
  countryName,
  networkKind,
  visibleFilters,
} from './attack-tracker-model';
import type { TrackPeriod } from './attack-tracker-model';
import { TrackerIcon } from './tracker-icons';
import type { TrackerFormat } from './tracker-format';

/** What a row's menu (and the detail's buttons) can start; the screen opens the dialog. */
export type SourceAction = 'allow' | 'mark' | 'unmark' | 'block' | 'unblock';

export interface SourcesCardProps {
  readonly period: TrackPeriod;
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly filter: TrackFilter;
  readonly onFilter: (filter: TrackFilter) => void;
  /** The first page's counts (chips) and total; null while the first page loads. */
  readonly first: TrackPage | null;
  readonly tracks: readonly TrackSummary[];
  readonly status: 'pending' | 'error' | 'success';
  readonly onRetry: () => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onMore: () => void;
  /** The row drawn selected (wide layout); null when none is. */
  readonly selectedId: string | null;
  readonly onSelect: (track: TrackSummary) => void;
  readonly onAction: (track: TrackSummary, action: SourceAction) => void;
  readonly format: TrackerFormat;
  readonly now: Date;
}

/**
 * The Sources card: search, filter chips with their counts, the list worst first
 * and its footer. The list is the server's order and the server's search; nothing is re-sorted or
 * filtered here.
 */
export function SourcesCard(props: SourcesCardProps) {
  const t = useT();
  const { first, tracks, status, filter, format } = props;
  const chips = visibleFilters(TRACK_FILTERS, first?.counts ?? null, filter);
  const searching = props.query.trim() !== '' || filter !== 'all';
  const total = first?.total ?? 0;

  return (
    <section className="tm-at-card" aria-labelledby="tm-at-sources-title">
      <h2 id="tm-at-sources-title" className="tm-visually-hidden">
        {t('AttackTracker.tileSources')}
      </h2>
      <SearchField
        className="tm-at-search"
        label={t('AttackTracker.searchLabel')}
        placeholder={t('AttackTracker.searchLabel')}
        value={props.query}
        autoComplete="off"
        onChange={(event) => props.onQuery(event.target.value)}
      />
      <div className="tm-at-filters" role="group" aria-label={t('AttackTracker.filtersLabel')}>
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            className="tm-at-chip"
            aria-pressed={filter === chip}
            onClick={() => props.onFilter(chip)}
          >
            {t(FILTER_LABEL[chip])}
            {first ? (
              <span className="tm-at-chip__count">{format.count(first.counts[chip])}</span>
            ) : null}
          </button>
        ))}
      </div>

      {status === 'pending' ? <SourcesLoading /> : null}
      {status === 'error' ? (
        <InlineAlert tone="danger" title={t('AttackTracker.couldNotLoad')} live>
          <Button tone="outline" size="compact" onClick={props.onRetry}>
            {t('AttackTracker.tryAgain')}
          </Button>
        </InlineAlert>
      ) : null}
      {status === 'success' && tracks.length === 0 ? (
        <p className="tm-at-empty" role="status">
          {searching ? t('AttackTracker.noMatch') : t(PERIOD_QUIET[props.period])}
        </p>
      ) : null}
      {status === 'success' && tracks.length > 0 ? (
        <>
          <SourcesTable {...props} />
          <div className="tm-at-foot">
            <p className="tm-at-secondary" role="status">
              {t('AttackTracker.showing')
                .replace('{shown}', format.count(tracks.length))
                .replace('{total}', format.count(total))}
            </p>
            {props.hasMore ? (
              <Button
                tone="outline"
                size="compact"
                disabled={props.loadingMore}
                onClick={props.onMore}
              >
                {t('AttackTracker.showMore')}
              </Button>
            ) : null}
          </div>
          {first?.truncated ? (
            <p className="tm-at-secondary">{t('AttackTracker.truncated')}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function SourcesLoading() {
  const t = useT();
  return (
    <div className="tm-at-empty" role="status" aria-label={t('AttackTracker.loadingSources')}>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} height="44px" radius="var(--r-compact)" />
      ))}
    </div>
  );
}

function SourcesTable(props: SourcesCardProps) {
  const t = useT();
  return (
    <table className="tm-at-table">
      <thead>
        <tr>
          <th scope="col">{t('AttackTracker.colSource')}</th>
          <th scope="col">{t('AttackTracker.colNetwork')}</th>
          <th scope="col" className="tm-at-num">
            {t('AttackTracker.colAttempts')}
          </th>
          <th scope="col" className="tm-at-num">
            {t('AttackTracker.colRefused')}
          </th>
          <th scope="col" className="tm-at-num">
            {t('AttackTracker.colSlowedDown')}
          </th>
          <th scope="col" className="tm-at-num">
            {t('AttackTracker.colGotIn')}
          </th>
          <th scope="col" className="tm-at-num">
            {t('AttackTracker.colLastSeen')}
          </th>
          <th scope="col">
            <span className="tm-visually-hidden">{t('AttackTracker.colActions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {props.tracks.map((track) => (
          <SourceRow key={track.trackId} track={track} {...props} />
        ))}
      </tbody>
    </table>
  );
}

function SourceRow({
  track,
  selectedId,
  onSelect,
  onAction,
  format,
  now,
}: SourcesCardProps & { readonly track: TrackSummary }) {
  const t = useT();
  const kind = networkKind(track.network);
  const country = countryName(track.network?.countryCode ?? null, format.locale);
  const selected = track.trackId === selectedId;
  return (
    <tr
      className="tm-at-row"
      data-selected={selected ? 'true' : undefined}
      onClick={(event) => {
        // The address button and the menu handle their own clicks.
        if ((event.target as HTMLElement).closest('button, a')) return;
        onSelect(track);
      }}
    >
      <td>
        <div className="tm-at-cell">
          <button
            type="button"
            className="tm-at-address tm-at-mono"
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(track)}
          >
            <bdi dir="ltr">{track.ip}</bdi>
          </button>
          <SourceCapsules track={track} />
          <span className="tm-at-secondary">
            {t('AttackTracker.firstSeenAt').replace('{when}', format.dayTime(track.firstSeen))}
          </span>
        </div>
      </td>
      <td>
        <div className="tm-at-cell tm-at-cell--network">
          {country ? <span>{country}</span> : null}
          {track.network?.owner ? (
            <span className="tm-at-secondary">
              <bdi>{track.network.owner}</bdi>
            </span>
          ) : null}
          {kind ? <StateCapsule state="neutral">{t(NETWORK_LABEL[kind])}</StateCapsule> : null}
        </div>
      </td>
      <td className="tm-at-num">{format.count(track.attempts)}</td>
      <td className="tm-at-num">{format.count(track.refused)}</td>
      <td className="tm-at-num">{format.count(track.throttled)}</td>
      <td className="tm-at-num">
        {track.succeeded > 0 ? (
          <span className="tm-at-split__got-in">{format.count(track.succeeded)}</span>
        ) : (
          format.count(0)
        )}
      </td>
      <td className="tm-at-num tm-at-last-seen">{format.lastSeen(track.lastSeen, now)}</td>
      <td className="tm-at-num">
        <RowMenu track={track} onAction={onAction} />
      </td>
    </tr>
  );
}

/** Severity first, then the platform's own marks (Blocked, Known tester). */
export function SourceCapsules({ track }: { readonly track: TrackSummary }) {
  const t = useT();
  return (
    <span className="tm-at-capsules">
      <StateCapsule
        state={SEVERITY_CAPSULE[track.severity]}
        {...(track.severity === 'low' ? { className: 'tm-at-capsule--low' } : {})}
      >
        {t(SEVERITY_LABEL[track.severity])}
      </StateCapsule>
      {track.blocked ? (
        <StateCapsule state="archived" className="tm-at-capsule--blocked">
          {t('AttackTracker.blocked')}
        </StateCapsule>
      ) : null}
      {track.label === 'known_tester' ? (
        <StateCapsule state="done" className="tm-at-capsule--tester">
          {t('AttackTracker.knownTester')}
        </StateCapsule>
      ) : null}
    </span>
  );
}

/** The row's "…": Add to allowlist, Mark as known tester, then Block last. */
function RowMenu({
  track,
  onAction,
}: {
  readonly track: TrackSummary;
  readonly onAction: (track: TrackSummary, action: SourceAction) => void;
}) {
  const t = useT();
  const menu = useMenuPopup('menuitem');
  const allow = allowlistAction(track);
  const pick = (action: SourceAction) => {
    menu.close();
    onAction(track, action);
  };
  return (
    <div className="tm-at-menu" ref={menu.root}>
      <button
        ref={menu.trigger}
        type="button"
        className="tm-at-icon-button tm-at-icon-button--small"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        aria-label={t('AttackTracker.rowMenu').replace('{address}', track.ip)}
        onClick={menu.toggle}
      >
        <TrackerIcon name="more" />
      </button>
      {menu.open ? (
        <ul
          id={menu.menuId}
          role="menu"
          className="tm-at-menu__list"
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => menu.onMenuKey(event)}
        >
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="tm-at-menu__item"
              aria-disabled={allow === 'on-list' ? true : undefined}
              onClick={() => {
                if (allow !== 'on-list') pick('allow');
              }}
            >
              {allow === 'on-list'
                ? t('AttackTracker.onAllowlist')
                : t('AttackTracker.addToAllowlist')}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="tm-at-menu__item"
              onClick={() => pick(track.label === 'known_tester' ? 'unmark' : 'mark')}
            >
              {track.label === 'known_tester'
                ? t('AttackTracker.removeTesterMark')
                : t('AttackTracker.markTester')}
            </button>
          </li>
          <li role="separator" className="tm-at-menu__divider" />
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="tm-at-menu__item"
              onClick={() => pick(track.blocked ? 'unblock' : 'block')}
            >
              {track.blocked ? t('AttackTracker.unblock') : t('AttackTracker.blockSource')}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
