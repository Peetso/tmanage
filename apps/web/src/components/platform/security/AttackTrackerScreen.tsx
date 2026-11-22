'use client';

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoButton, StateCapsule } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  fetchAttackTrack,
  fetchNetworkAccess,
  listAttackTracks,
  setNetworkPolicy,
} from '../../../lib/api/platform-security';
import type { TrackFilter, TrackSummary } from '../../../lib/api/platform-security';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';
import {
  PERIOD_LABEL,
  PERIOD_SUMMARY,
  TRACK_PERIODS,
  allowlistAction,
  allowlistEntryHolding,
  periodFrom,
  selectedTrack,
} from './attack-tracker-model';
import type { TrackPeriod } from './attack-tracker-model';
import { AllowlistCard, SignInDoorCard } from './DoorCards';
import { SourceDetail } from './SourceDetail';
import { SourcesCard } from './SourcesCard';
import type { SourceAction } from './SourcesCard';
import { DOOR_KEY, TRACKS_KEY, TRACK_KEY, TrackerDialogs } from './TrackerDialogs';
import type { TrackerDialogState } from './TrackerDialogs';
import { TrackerIcon } from './tracker-icons';
import { useTrackerFormat } from './tracker-format';
import './attack-tracker.css';

/** Search waits this long after the last key before it asks the server. */
const SEARCH_DELAY_MS = 300;
/** Under this width the detail is a side sheet (Figma 840:2909, 1024 px). */
const WIDE_QUERY = '(min-width: 1100px)';

/**
 * Platform admin › Security › Attack tracker (Figma 833:85442; Fix 1 frames 840:1578 EN light,
 * 840:906 AR light, 840:2243 EN dark, 840:2909 side sheet, 841:906 / 841:1622 states).
 *
 * Every source that failed, was refused or was slowed down at sign-in, worst first, with one
 * source's facts and timeline beside the list, the allowlist and the sign-in door. Every read and
 * write needs `platform.settings.edit` behind a fresh step-up; the server audits each one.
 */
export function AttackTrackerScreen({
  client,
  now = () => new Date(),
}: ScreenProps & { readonly now?: () => Date }) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [period, setPeriod] = useState<TrackPeriod>('7d');
  const [anchor, setAnchor] = useState(() => now());
  const queryClient = useQueryClient();

  const refresh = () => {
    setAnchor(now());
    void queryClient.invalidateQueries({ queryKey: TRACKS_KEY });
    void queryClient.invalidateQueries({ queryKey: TRACK_KEY });
    void queryClient.invalidateQueries({ queryKey: DOOR_KEY });
  };

  return (
    <PlatformGate
      api={api}
      section="attack-tracker"
      crumbs={[t('PlatformShell.securityLabel'), t('AttackTracker.title')]}
      title={
        <span className="tm-at-title">
          {t('AttackTracker.title')}
          <InfoButton title={t('AttackTracker.title')} label={t('AttackTracker.aboutTracker')}>
            {t('AttackTracker.infoTracker')}
          </InfoButton>
        </span>
      }
      description={t(PERIOD_SUMMARY[period])}
      actions={() => (
        <div className="tm-at-head-actions">
          <div role="group" aria-label={t('AttackTracker.periodLabel')} className="tm-at-filters">
            {TRACK_PERIODS.map((option) => (
              <button
                key={option}
                type="button"
                className="tm-at-chip"
                aria-pressed={period === option}
                onClick={() => {
                  setPeriod(option);
                  setAnchor(now());
                }}
              >
                {t(PERIOD_LABEL[option])}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="tm-at-icon-button"
            aria-label={t('AttackTracker.refresh')}
            onClick={refresh}
          >
            <TrackerIcon name="refresh" />
          </button>
        </div>
      )}
    >
      {() => <TrackerBody api={api} period={period} anchor={anchor} />}
    </PlatformGate>
  );
}

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const query = window.matchMedia(WIDE_QUERY);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(WIDE_QUERY).matches
        : true,
    () => true,
  );
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

/** A step-up that lapsed mid-session re-opens the step-up form instead of an error. */
function onReadError(queryClient: ReturnType<typeof useQueryClient>, error: unknown) {
  if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
    void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
  }
}

function TrackerBody({
  api,
  period,
  anchor,
}: {
  readonly api: ApiClient;
  readonly period: TrackPeriod;
  readonly anchor: Date;
}) {
  const t = useT();
  const format = useTrackerFormat();
  const queryClient = useQueryClient();
  const wide = useWide();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TrackFilter>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<TrackerDialogState | null>(null);
  const [notice, setNotice] = useState('');
  const [doorError, setDoorError] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const q = useDebounced(query.trim());
  const from = periodFrom(period, anchor);

  // The tiles read the whole window (the API's windowTotals), whatever the chips and the search
  // narrow the list to; its own key keeps them steady while a chip or a search reloads the list.
  const totals = useQuery({
    queryKey: [...TRACKS_KEY, 'totals', from],
    queryFn: () => listAttackTracks(api, { from, filter: 'all', q: '' }),
    retry: false,
  });
  const list = useInfiniteQuery({
    queryKey: [...TRACKS_KEY, 'list', from, filter, q],
    queryFn: ({ pageParam }) =>
      listAttackTracks(api, { from, filter, q, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const door = useQuery({
    queryKey: DOOR_KEY,
    queryFn: () => fetchNetworkAccess(api),
    retry: false,
  });

  const tracks = list.data?.pages.flatMap((page) => page.tracks) ?? [];
  const first = list.data?.pages[0] ?? null;
  const shown = wide
    ? selectedTrack(tracks, picked)
    : (tracks.find((track) => track.trackId === picked) ?? null);
  const detail = useQuery({
    queryKey: [...TRACK_KEY, shown?.trackId ?? null],
    queryFn: () => fetchAttackTrack(api, shown?.trackId ?? ''),
    enabled: shown !== null && (wide || sheetOpen),
    retry: false,
  });

  const readError = totals.error ?? list.error ?? door.error ?? detail.error;
  useEffect(() => {
    if (readError) onReadError(queryClient, readError);
  }, [queryClient, readError]);

  const turnOn = useMutation({
    mutationFn: () => setNetworkPolicy(api, 'refuse'),
    onSuccess: async () => {
      setDoorError('');
      setNotice(t('AttackTracker.doneDoorOn'));
      await queryClient.invalidateQueries({ queryKey: DOOR_KEY });
    },
    onError: (error) => {
      onReadError(queryClient, error);
      setDoorError(platformErrorText(error, t));
    },
  });

  const open = useCallback((next: TrackerDialogState) => {
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    setDialog(next);
  }, []);

  const closeDialog = (done: string | null) => {
    setDialog(null);
    if (done) setNotice(done);
    const back = opener.current;
    opener.current = null;
    // The opener may have gone (a row menu closes); fall back to nothing rather than the body.
    requestAnimationFrame(() => back?.isConnected && back.focus());
  };

  const act = (track: TrackSummary, action: SourceAction) => {
    const entries = door.data?.entries ?? [];
    switch (action) {
      case 'block':
        open({ kind: 'block', track, overlap: allowlistEntryHolding(track, entries) });
        return;
      case 'unblock': {
        const note = door.data?.blocked.find((entry) => entry.id === track.blockId)?.note ?? null;
        open({ kind: 'unblock', track, note });
        return;
      }
      case 'allow':
        open(
          allowlistAction(track) === 'blocked'
            ? { kind: 'allow-refused', track }
            : { kind: 'allow-source', track },
        );
        return;
      case 'mark':
        open({ kind: 'mark', track });
        return;
      case 'unmark':
        open({ kind: 'unmark', track });
    }
  };

  const select = (track: TrackSummary) => {
    setPicked(track.trackId);
    if (!wide) {
      if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      setSheetOpen(true);
    }
  };

  const whole = totals.data?.windowTotals ?? null;
  const detailHeading = useId();
  const detailCard = shown ? (
    <SourceDetail
      detail={detail.data}
      status={detail.status}
      onRetry={() => void detail.refetch()}
      format={format}
      headingId={detailHeading}
      onAction={(action) => act(detail.data ?? shown, action)}
      onAccounts={(data) => open({ kind: 'accounts', detail: data })}
      onSignOut={(account, data) => open({ kind: 'sign-out', account, detail: data })}
    />
  ) : null;

  const doorCard = (
    <SignInDoorCard
      door={door.data}
      status={door.status}
      onRetry={() => void door.refetch()}
      format={format}
      now={anchor}
      busy={turnOn.isPending}
      onTurnOn={() => turnOn.mutate()}
      onTurnOff={() => open({ kind: 'door-off' })}
    />
  );

  return (
    <div className="tm-at">
      <p className="tm-visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      <dl className="tm-at-tiles">
        <Tile
          label={t('AttackTracker.tileSources')}
          value={whole ? format.count(whole.sources) : null}
        />
        <Tile
          label={t('AttackTracker.gotInAfterFailing')}
          value={whole ? format.count(whole.gotIn) : null}
          capsule={
            whole && whole.gotIn > 0 ? (
              <StateCapsule state="blocked">{t('AttackTracker.severityCritical')}</StateCapsule>
            ) : null
          }
        />
        <Tile
          label={t('AttackTracker.refused')}
          value={whole ? format.count(whole.refused) : null}
        />
        <Tile
          label={t('AttackTracker.slowedDown')}
          value={whole ? format.count(whole.throttled) : null}
        />
      </dl>

      <div className="tm-at-columns">
        <div className="tm-at-column">
          <SourcesCard
            period={period}
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            first={first}
            tracks={tracks}
            status={list.status}
            onRetry={() => void list.refetch()}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
            selectedId={wide ? (shown?.trackId ?? null) : null}
            onSelect={select}
            onAction={act}
            format={format}
            now={anchor}
          />
          <AllowlistCard
            door={door.data}
            status={door.status}
            onRetry={() => void door.refetch()}
            format={format}
            onAdd={() => open({ kind: 'allow-add' })}
            onRemove={(entry) => open({ kind: 'allow-remove', entry })}
          />
        </div>
        <div className="tm-at-column">
          {wide && detailCard ? (
            <section className="tm-at-card tm-at-card--strong" aria-labelledby={detailHeading}>
              {detailCard}
            </section>
          ) : null}
          {doorError ? (
            <p className="tm-at-secondary" role="alert">
              {doorError}
            </p>
          ) : null}
          {doorCard}
        </div>
      </div>

      {!wide && sheetOpen && detailCard ? (
        <SideSheet
          labelledBy={detailHeading}
          onClose={() => {
            setSheetOpen(false);
            const back = opener.current;
            opener.current = null;
            requestAnimationFrame(() => back?.isConnected && back.focus());
          }}
        >
          {detailCard}
        </SideSheet>
      ) : null}

      {dialog ? (
        <TrackerDialogs
          key={dialogKey(dialog)}
          api={api}
          dialog={dialog}
          onOpen={setDialog}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}

function dialogKey(dialog: TrackerDialogState): string {
  switch (dialog.kind) {
    case 'allow-remove':
      return `${dialog.kind}:${dialog.entry.id}`;
    case 'sign-out':
      return `${dialog.kind}:${dialog.account.userId}`;
    case 'accounts':
      return `${dialog.kind}:${dialog.detail.trackId}`;
    case 'allow-add':
    case 'door-off':
      return dialog.kind;
    default:
      return `${dialog.kind}:${dialog.track.trackId}`;
  }
}

function Tile({
  label,
  value,
  capsule = null,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly capsule?: ReactNode;
}) {
  return (
    <div className="tm-at-tile">
      <dt>{label}</dt>
      <dd>
        {value ?? '–'}
        {capsule}
      </dd>
    </div>
  );
}

const SHEET_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The 1024 px layout's detail (Figma 840:2909): a modal sheet at the end edge with a close button. */
function SideSheet({
  labelledBy,
  onClose,
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(SHEET_FOCUSABLE)?.focus();
  }, []);

  function onKey(event: KeyboardEvent<HTMLElement>) {
    // A dialog opened from the sheet handles its own keys.
    if (event.defaultPrevented || (event.target as HTMLElement).closest('.tm-at-dialog')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)];
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (firstItem === undefined || lastItem === undefined) return;
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem.focus();
    }
  }

  return (
    // A press on the scrim closes the sheet for a pointer; Escape and the Close button are the
    // keyboard and screen-reader ways out, so the scrim itself stays out of the tab order.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="tm-at-sheet"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* The modal's own Escape and Tab handling (WAI-ARIA APG, Dialog (Modal) pattern). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="tm-at-sheet__panel tm-at-card tm-at-card--strong"
        onKeyDown={onKey}
      >
        <div className="tm-at-card__head">
          <span />
          <button
            type="button"
            className="tm-at-icon-button tm-at-icon-button--small"
            aria-label={t('AttackTracker.close')}
            onClick={onClose}
          >
            <TrackerIcon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
