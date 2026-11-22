'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import Link from 'next/link';
import { StateCapsule, Tooltip, MOTION_DELAY_TOOLTIP_MS } from '@tmanage/ui';
import { NavIcon } from '../icons/phone';
import type { PhoneIconName } from '../icons/phone';
import type { TodaySlot } from '../../lib/use-today-slots';
import { usePendingWrites } from '../../lib/offline/use-offline';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { AllLink, MyDayWidget } from './MyDayWidget';
import type { WidgetState } from './MyDayWidget';
import {
  LIST_ROWS,
  daysLate,
  dueGroup,
  dueRows,
  isOnOthers,
  waitingId,
  waitingSince,
} from './my-day-model';
import type {
  DueFilter,
  MyDayCounts,
  MyDayEntry,
  NextPick,
  ProjectRow,
  WaitingEntry,
} from './my-day-model';
import { clock, dueLabel, lateLabel, waitedFor } from './my-day-format';

/** What every work widget needs to name things and link to them. */
export interface WidgetContext {
  readonly slug: string;
  readonly projectName: (projectId: string) => string;
  /** The clock the page reads once per render, so every widget agrees on "today". */
  readonly now: number;
}

/* ── Chips ──────────────────────────────────────────────────────────────────────────────── */

/** The status chip of a row: "3 days late" (danger edge, clock icon, R5) or the due word. */
export function DueChip({ entry, now }: { readonly entry: MyDayEntry; readonly now: number }) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const group = dueGroup(entry, now);
  if (group === 'overdue') {
    return (
      <span className="tm-myday-chip tm-myday-chip--late">
        <NavIcon name="clock" size={14} className="tm-myday-chip__glyph" />
        {lateLabel(tOr, locale, daysLate(entry, now))}
      </span>
    );
  }
  return (
    <span className="tm-myday-chip" data-group={group}>
      <span className="tm-myday-chip__mark" aria-hidden="true" />
      {dueLabel(tOr, locale, entry.workItem.dueAt, now)}
    </span>
  );
}

/* ── W1 Today ───────────────────────────────────────────────────────────────────────────── */

const JOIN_WINDOW_MS = 30 * 60_000;

export function TodayWidget({
  ctx,
  slots,
  state,
  onRetry,
}: {
  readonly ctx: WidgetContext;
  readonly slots: readonly TodaySlot[];
  readonly state: WidgetState;
  readonly onRetry: () => void;
}) {
  const t = useT();
  const calendar = (
    <Link href={`/${ctx.slug}/calendar`} className="tm-myday-link tm-myday-today__calendar">
      {t('MyDay.calendar')}
      <NavIcon name="forward" size={16} />
    </Link>
  );
  return (
    <MyDayWidget
      id="pulse"
      title={t('MyDay.w.today')}
      info={t('MyDay.info.today')}
      state={state === 'empty' ? 'ready' : state}
      skeletonRows={1}
      skeletonHeight="36px"
      onRetry={onRetry}
      className="tm-myday-w--today"
    >
      <div className="tm-myday-today">
        <span className="tm-myday-today__now">
          {t('MyDay.now')} <strong>{clock(ctx.now)}</strong>
        </span>
        {slots.length === 0 ? (
          <span className="tm-myday-today__empty">{t('MyDay.nothingScheduled')}</span>
        ) : (
          <ul className="tm-myday-today__chips" aria-label={t('MyDay.w.today')}>
            {slots.map((slot) => (
              <TodayChip key={slot.id} slot={slot} now={ctx.now} />
            ))}
          </ul>
        )}
        {calendar}
      </div>
    </MyDayWidget>
  );
}

function TodayChip({ slot, now }: { readonly slot: TodaySlot; readonly now: number }) {
  const t = useT();
  // Join sits on the next meeting once it is under 30 minutes away (823:1312); the meeting under
  // way is the highlighted chip itself, which opens the meeting.
  const joinable =
    slot.kind === 'meeting' && slot.state === 'next' && slot.start - now <= JOIN_WINDOW_MS;
  const label = slot.kind === 'focus' ? fill(t('MyDay.focus'), { title: slot.label }) : slot.label;
  return (
    <li className="tm-myday-slot" data-state={slot.state} data-kind={slot.kind}>
      <Link href={slot.href} className="tm-myday-slot__link">
        {slot.state === 'done' ? (
          <>
            <NavIcon name="check" size={16} className="tm-myday-slot__glyph" />
            <span className="tm-visually-hidden">{t('MyDay.slotDone')}: </span>
          </>
        ) : null}
        {slot.kind === 'focus' ? (
          <NavIcon name="lock" size={16} className="tm-myday-slot__glyph" />
        ) : null}
        {slot.state === 'now' ? (
          <span className="tm-visually-hidden">{t('MyDay.slotNow')}: </span>
        ) : null}
        <span className="tm-myday-slot__time">{clock(slot.start)}</span>
        <span className="tm-myday-slot__label">{label}</span>
      </Link>
      {joinable ? (
        <Link href={slot.href} className="tm-myday-slot__join">
          {t('MyDay.join')}
          <span className="tm-visually-hidden">: {slot.label}</span>
        </Link>
      ) : null}
    </li>
  );
}

/* ── W2 Next ────────────────────────────────────────────────────────────────────────────── */

export type NextMode = 'pick' | 'newMember' | 'allDone';

export function NextWidget({
  ctx,
  pick,
  mode,
  state,
  onRetry,
  onDecide,
}: {
  readonly ctx: WidgetContext;
  readonly pick: NextPick;
  readonly mode: NextMode;
  readonly state: WidgetState;
  readonly onRetry: () => void;
  /** An approval's Approve or Send back, decided in the approval sheet. */
  readonly onDecide: (
    entry: Extract<WaitingEntry, { kind: 'approval' }>,
    verdict: 'approve' | 'request_changes',
    subject: string,
  ) => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();

  let body: ReactNode = null;
  if (mode === 'newMember') {
    body = (
      <div className="tm-myday-next">
        <p className="tm-myday-next__title">{t('MyDay.firstTask')}</p>
        <div className="tm-myday-next__actions">
          <Link
            href={`/${ctx.slug}/capture`}
            className="tm-button tm-button--lime tm-button--feature tm-myday-primary"
          >
            {t('MyDay.newTask')}
          </Link>
        </div>
      </div>
    );
  } else if (mode === 'allDone' || pick === null) {
    body = (
      <div className="tm-myday-next">
        <p className="tm-myday-next__title">{t('MyDay.nothingNeedsYou')}</p>
      </div>
    );
  } else if (pick.kind === 'work') {
    const item = pick.entry.workItem;
    const href = `/${ctx.slug}/work/${encodeURIComponent(item.id)}`;
    body = (
      <div className="tm-myday-next" data-late={pick.entry.reason === 'overdue' || undefined}>
        <div className="tm-myday-next__text">
          <Link href={href} className="tm-myday-next__title tm-myday-next__cover">
            {item.title}
          </Link>
          <p className="tm-myday-next__meta">
            <span>{ctx.projectName(item.projectId)}</span>
            <DueChip entry={pick.entry} now={ctx.now} />
          </p>
        </div>
        <div className="tm-myday-next__actions">
          <Link
            href={href}
            className="tm-button tm-button--lime tm-button--feature tm-myday-primary"
          >
            {t('MyDay.open')}
            <span className="tm-visually-hidden">: {item.title}</span>
          </Link>
        </div>
      </div>
    );
  } else {
    const entry = pick.entry;
    const title =
      entry.kind === 'approval'
        ? approvalSubject(entry, t('MyDay.deliverableReview'))
        : entry.title;
    const href = waitingHref(ctx.slug, entry);
    body = (
      <div className="tm-myday-next">
        <div className="tm-myday-next__text">
          <Link href={href} className="tm-myday-next__title tm-myday-next__cover">
            {title}
          </Link>
          <p className="tm-myday-next__meta">
            <span>{ctx.projectName(entry.projectId)}</span>
            <span className="tm-myday-chip">
              <NavIcon name="clock" size={14} className="tm-myday-chip__glyph" />
              {waitedFor(tOr, locale, waitingSince(entry), ctx.now)}
            </span>
          </p>
        </div>
        <div className="tm-myday-next__actions">
          {entry.kind === 'approval' ? (
            <>
              <button
                type="button"
                className="tm-myday-link tm-myday-next__secondary"
                onClick={() => onDecide(entry, 'request_changes', title)}
              >
                {t('MyDay.sendBack')}
                <span className="tm-visually-hidden">: {title}</span>
              </button>
              <button
                type="button"
                className="tm-button tm-button--lime tm-button--feature tm-myday-primary"
                onClick={() => onDecide(entry, 'approve', title)}
              >
                {t('MyDay.approve')}
                <span className="tm-visually-hidden">: {title}</span>
              </button>
            </>
          ) : (
            <Link
              href={href}
              className="tm-button tm-button--lime tm-button--feature tm-myday-primary"
            >
              {t('MyDay.reply')}
              <span className="tm-visually-hidden">: {title}</span>
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <MyDayWidget
      id="next"
      title={t('MyDay.w.next')}
      info={t('MyDay.info.next')}
      state={state === 'empty' ? 'ready' : state}
      skeletonRows={2}
      skeletonHeight="44px"
      onRetry={onRetry}
      className="tm-myday-w--next"
    >
      {body}
    </MyDayWidget>
  );
}

/** "Homepage concept · v2": the deliverable and its version, else the generic label. */
export function approvalSubject(
  entry: Extract<WaitingEntry, { kind: 'approval' }>,
  generic: string,
): string {
  if (entry.deliverableTitle === null) return generic;
  return entry.versionNo === null
    ? entry.deliverableTitle
    : `${entry.deliverableTitle} · v${entry.versionNo}`;
}

/** Where a waiting row opens: the project's approvals, or the client request itself (REQ-11). */
export function waitingHref(slug: string, entry: WaitingEntry): string {
  return entry.kind === 'approval'
    ? `/${slug}/projects/${encodeURIComponent(entry.projectId)}`
    : `/${slug}/work/requests/${encodeURIComponent(entry.clientRequestId)}`;
}

/* ── W3 At a glance ─────────────────────────────────────────────────────────────────────── */

export function GlanceWidget({
  counts,
  state,
  onRetry,
  onJump,
}: {
  readonly counts: MyDayCounts;
  readonly state: WidgetState;
  readonly onRetry: () => void;
  /** A tile opens its widget (spec W3): Due & at risk, Waiting, Today. */
  readonly onJump: (widget: 'myDay' | 'waiting' | 'pulse') => void;
}) {
  const t = useT();
  const tiles = [
    {
      widget: 'myDay' as const,
      value: counts.open,
      label: t('MyDay.glanceOpen'),
      tip: t('MyDay.info.glanceOpen'),
    },
    {
      widget: 'waiting' as const,
      value: counts.waitingOnYou,
      label: t('MyDay.glanceWaiting'),
      tip: t('MyDay.info.glanceWaiting'),
    },
    {
      widget: 'pulse' as const,
      value: counts.meetings,
      label: t('MyDay.glanceMeetings'),
      tip: t('MyDay.info.glanceMeetings'),
    },
  ];
  return (
    <MyDayWidget
      id="summary"
      title={t('MyDay.w.glance')}
      info={t('MyDay.info.glance')}
      state={state === 'empty' ? 'ready' : state}
      skeletonRows={1}
      skeletonHeight="72px"
      onRetry={onRetry}
    >
      <ul className="tm-myday-tiles">
        {tiles.map((tile) => (
          <li key={tile.widget}>
            <Tooltip content={tile.tip} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="bottom">
              <button type="button" className="tm-myday-tile" onClick={() => onJump(tile.widget)}>
                <span className="tm-myday-tile__value">{tile.value}</span>
                <span className="tm-myday-tile__label">{tile.label}</span>
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </MyDayWidget>
  );
}

/* ── W4 Due & at risk ───────────────────────────────────────────────────────────────────── */

export interface DueRowActions {
  readonly onComplete: (entry: MyDayEntry) => void;
  readonly onLogTime: (entry: MyDayEntry) => void;
  readonly onStartTimer: (entry: MyDayEntry) => void;
  /** Open the Task story panel (the context lens) for this row. */
  readonly onSelect: (entry: MyDayEntry) => void;
}

export function DueWidget({
  ctx,
  items,
  counts,
  nextWorkId,
  filter,
  onFilter,
  state,
  onRetry,
  selectedId,
  completing,
  actions,
}: {
  readonly ctx: WidgetContext;
  readonly items: readonly MyDayEntry[];
  readonly counts: MyDayCounts;
  readonly nextWorkId: string | null;
  readonly filter: DueFilter;
  readonly onFilter: (filter: DueFilter) => void;
  readonly state: WidgetState;
  readonly onRetry: () => void;
  readonly selectedId: string | null;
  readonly completing: ReadonlySet<string>;
  readonly actions: DueRowActions;
}) {
  const t = useT();
  const rows = dueRows(items, filter, nextWorkId, ctx.now, LIST_ROWS.wide);
  const nextGroup = (() => {
    const next = items.find((entry) => entry.workItem.id === nextWorkId);
    return next ? dueGroup(next, ctx.now) : null;
  })();
  const chips: {
    readonly id: Exclude<DueFilter, null>;
    readonly label: string;
    readonly count: number;
  }[] = [
    { id: 'today', label: t('MyDay.chipToday'), count: counts.today },
    { id: 'overdue', label: t('MyDay.chipOverdue'), count: counts.overdue },
    { id: 'soon', label: t('MyDay.chipDueSoon'), count: counts.soon },
  ];
  const emptyLine =
    filter === 'overdue'
      ? t('MyDay.nothingOverdue')
      : filter === 'today'
        ? t('MyDay.nothingToday')
        : filter === 'soon'
          ? t('MyDay.nothingSoon')
          : t('MyDay.nothingDue');

  const header = (
    <div className="tm-myday-chips" role="group" aria-label={t('MyDay.chipsLabel')}>
      {chips.map((chip) => {
        // Ruling (b): the count includes the Next item; the tooltip and name say where it is.
        const inNext = nextGroup === chip.id && chip.count > 0;
        const name = inNext
          ? `${chip.label} ${fill(t('MyDay.chipInNext'), { count: chip.count })}`
          : `${chip.label} ${chip.count}`;
        const button = (
          <button
            type="button"
            className="tm-myday-filter"
            aria-pressed={filter === chip.id}
            aria-label={name}
            onClick={() => onFilter(filter === chip.id ? null : chip.id)}
          >
            <span>{chip.label}</span>
            <span className="tm-myday-filter__count" aria-hidden="true">
              {chip.count}
            </span>
          </button>
        );
        return inNext ? (
          <Tooltip
            key={chip.id}
            content={fill(t('MyDay.chipInNext'), { count: chip.count })}
            delayMs={MOTION_DELAY_TOOLTIP_MS}
            placement="bottom"
          >
            {button}
          </Tooltip>
        ) : (
          <span key={chip.id} className="tm-myday-filter-slot">
            {button}
          </span>
        );
      })}
    </div>
  );

  const ready = state === 'ready' && rows.length === 0 ? 'empty' : state;
  return (
    <MyDayWidget
      id="myDay"
      title={t('MyDay.w.due')}
      info={t('MyDay.info.due')}
      actions={header}
      state={ready}
      empty={emptyLine}
      skeletonRows={5}
      onRetry={onRetry}
      className="tm-myday-w--due"
    >
      <ul className="tm-myday-rows tm-myday-rows--due" aria-label={t('MyDay.w.due')}>
        {rows.map((entry) => (
          <DueRow
            key={entry.workItem.id}
            ctx={ctx}
            entry={entry}
            selected={entry.workItem.id === selectedId}
            completing={completing.has(entry.workItem.id)}
            actions={actions}
          />
        ))}
      </ul>
      <div className="tm-myday-w__foot">
        <AllLink href={`/${ctx.slug}/work`} count={counts.open} label={t('MyDay.w.due')} />
      </div>
    </MyDayWidget>
  );
}

function DueRow({
  ctx,
  entry,
  selected,
  completing,
  actions,
}: {
  readonly ctx: WidgetContext;
  readonly entry: MyDayEntry;
  readonly selected: boolean;
  readonly completing: boolean;
  readonly actions: DueRowActions;
}) {
  const t = useT();
  const item = entry.workItem;
  // Offline, a logged time waits in the queue: the row says so (spec W4 state O).
  const pending = usePendingWrites(ctx.slug, item.id, 'time-log');
  return (
    <li className="tm-myday-row" data-selected={selected || undefined}>
      <button
        type="button"
        className="tm-myday-complete"
        aria-label={fill(t('MyDay.complete'), { title: item.title })}
        disabled={completing}
        onClick={() => actions.onComplete(entry)}
      >
        <span className="tm-myday-complete__ring" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tm-myday-row__title"
        aria-haspopup="dialog"
        aria-expanded={selected}
        onClick={() => actions.onSelect(entry)}
      >
        {item.title}
      </button>
      <span className="tm-myday-row__project">{ctx.projectName(item.projectId)}</span>
      <span className="tm-myday-row__chip">
        {pending.length > 0 ? (
          <StateCapsule state="waiting">{t('MyDay.notSentYet')}</StateCapsule>
        ) : (
          <DueChip entry={entry} now={ctx.now} />
        )}
      </span>
      <RowMenu
        label={fill(t('MyDay.rowMore'), { title: item.title })}
        items={[
          {
            id: 'reschedule',
            label: t('MyDay.reschedule'),
            href: `/${ctx.slug}/work/${encodeURIComponent(item.id)}`,
          },
          { id: 'log', label: t('MyDay.logTime'), onSelect: () => actions.onLogTime(entry) },
          {
            id: 'timer',
            label: t('MyDay.startTimer'),
            onSelect: () => actions.onStartTimer(entry),
          },
        ]}
      />
    </li>
  );
}

/* ── The row "⋯" menu (WAI-ARIA APG menu button) ─────────────────────────────────────────── */

export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
  readonly onSelect?: () => void;
}

export function RowMenu({
  label,
  items,
  className,
}: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (open) itemRefs.current[focus]?.focus();
  }, [open, focus]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const last = items.length - 1;
    if (event.key === 'ArrowDown') setFocus((index) => (index >= last ? 0 : index + 1));
    else if (event.key === 'ArrowUp') setFocus((index) => (index <= 0 ? last : index - 1));
    else if (event.key === 'Home') setFocus(0);
    else if (event.key === 'End') setFocus(last);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  return (
    <div className={`tm-myday-menu${className ? ` ${className}` : ''}`} ref={root}>
      <Tooltip content={label} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="bottom">
        <button
          ref={button}
          type="button"
          className="tm-myday-icon"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setFocus(0);
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setFocus(event.key === 'ArrowDown' ? 0 : items.length - 1);
              setOpen(true);
            }
          }}
        >
          <NavIcon name="dots" size={16} />
        </button>
      </Tooltip>
      {open ? (
        <ul id={menuId} role="menu" className="tm-myday-menu__list" onKeyDown={onMenuKey}>
          {items.map((item, index) =>
            item.href ? (
              <li key={item.id} role="none">
                <Link
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  role="menuitem"
                  tabIndex={index === focus ? 0 : -1}
                  href={item.href}
                  className="tm-myday-menu__item"
                >
                  {item.label}
                </Link>
              </li>
            ) : (
              <li key={item.id} role="none">
                <button
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === focus ? 0 : -1}
                  className="tm-myday-menu__item"
                  onClick={() => {
                    close(true);
                    item.onSelect?.();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

/* ── W5 Waiting ─────────────────────────────────────────────────────────────────────────── */

type WaitingTab = 'onYou' | 'onOthers';

export function WaitingWidget({
  ctx,
  onYou,
  onOthers,
  counts,
  nextWaitingId,
  state,
  onRetry,
}: {
  readonly ctx: WidgetContext;
  readonly onYou: readonly WaitingEntry[];
  readonly onOthers: readonly WaitingEntry[];
  readonly counts: MyDayCounts;
  readonly nextWaitingId: string | null;
  readonly state: WidgetState;
  readonly onRetry: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<WaitingTab>('onYou');
  const tabsId = useId();
  const tabRefs = useRef<Record<WaitingTab, HTMLButtonElement | null>>({
    onYou: null,
    onOthers: null,
  });
  const list = (tab === 'onYou' ? onYou : onOthers)
    .filter((entry) => waitingId(entry) !== nextWaitingId)
    .slice(0, LIST_ROWS.narrow - 1);
  const tabs: {
    readonly id: WaitingTab;
    readonly label: string;
    readonly count: number;
    readonly tip: string;
  }[] = [
    {
      id: 'onYou',
      label: t('MyDay.tabOnYou'),
      count: counts.waitingOnYou,
      tip: t('MyDay.info.waiting'),
    },
    {
      id: 'onOthers',
      label: t('MyDay.tabOnOthers'),
      count: counts.waitingOnOthers,
      tip: t('MyDay.info.waitingOthers'),
    },
  ];
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: WaitingTab = tab === 'onYou' ? 'onOthers' : 'onYou';
    const to = event.key === 'Home' ? 'onYou' : event.key === 'End' ? 'onOthers' : next;
    setTab(to);
    tabRefs.current[to]?.focus();
  };
  const panelId = `${tabsId}-panel`;
  const ready = state === 'ready' && list.length === 0 ? 'empty' : state;

  return (
    <MyDayWidget
      id="waiting"
      title={t('MyDay.w.waiting')}
      info={t('MyDay.info.waiting')}
      state={state}
      skeletonRows={3}
      skeletonHeight="48px"
      onRetry={onRetry}
      className="tm-myday-w--waiting"
    >
      <div className="tm-myday-tabs" role="tablist" aria-label={t('MyDay.w.waiting')}>
        {tabs.map((item) => (
          <Tooltip
            key={item.id}
            content={item.tip}
            delayMs={MOTION_DELAY_TOOLTIP_MS}
            placement="bottom"
          >
            <button
              ref={(node) => {
                tabRefs.current[item.id] = node;
              }}
              type="button"
              role="tab"
              id={`${tabsId}-${item.id}`}
              className="tm-myday-tab"
              aria-selected={tab === item.id}
              aria-controls={panelId}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={onTabKey}
            >
              {item.label} {item.count}
            </button>
          </Tooltip>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={`${tabsId}-${tab}`}>
        {ready === 'empty' ? (
          <div className="tm-myday-w__line">{t('MyDay.nothingWaiting')}</div>
        ) : (
          <ul className="tm-myday-rows tm-myday-rows--waiting">
            {list.map((entry) => (
              <WaitingRow key={waitingId(entry)} ctx={ctx} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </MyDayWidget>
  );
}

function WaitingRow({ ctx, entry }: { readonly ctx: WidgetContext; readonly entry: WaitingEntry }) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const title =
    entry.kind === 'approval' ? approvalSubject(entry, t('MyDay.deliverableReview')) : entry.title;
  const icon: PhoneIconName = entry.kind === 'approval' ? 'layers' : 'chat';
  const action = isOnOthers(entry)
    ? t('MyDay.nudge')
    : entry.kind === 'approval'
      ? t('MyDay.review')
      : t('MyDay.reply');
  return (
    <li className="tm-myday-row tm-myday-row--waiting">
      <NavIcon name={icon} size={16} className="tm-myday-row__kind" />
      <span className="tm-myday-row__text">
        <span className="tm-myday-row__name">{title}</span>
        <span className="tm-myday-row__meta">
          {ctx.projectName(entry.projectId)} ·{' '}
          {waitedFor(tOr, locale, waitingSince(entry), ctx.now)}
        </span>
      </span>
      <Link
        href={waitingHref(ctx.slug, entry)}
        className="tm-button tm-button--outline tm-button--compact tm-myday-row__action"
      >
        {action}
        <span className="tm-visually-hidden">: {title}</span>
      </Link>
    </li>
  );
}

/* ── W6 By project ──────────────────────────────────────────────────────────────────────── */

export function ByProjectWidget({
  ctx,
  rows,
  state,
  onRetry,
}: {
  readonly ctx: WidgetContext;
  readonly rows: readonly ProjectRow[];
  readonly state: WidgetState;
  readonly onRetry: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [open, setOpen] = useState<string | null>(null);
  const shown = rows.slice(0, LIST_ROWS.projects);
  const ready = state === 'ready' && rows.length === 0 ? 'empty' : state;
  return (
    <MyDayWidget
      id="byProject"
      title={t('MyDay.w.byProject')}
      info={t('MyDay.info.byProject')}
      actions={
        <AllLink
          href={`/${ctx.slug}/projects`}
          count={rows.length}
          label={t('MyDay.w.byProject')}
        />
      }
      state={ready}
      empty={t('MyDay.noOpenWork')}
      skeletonRows={4}
      onRetry={onRetry}
    >
      <ul className="tm-myday-rows tm-myday-rows--projects">
        {shown.map((row) => {
          const expanded = open === row.projectId;
          const panelId = `tm-myday-project-${row.projectId}`;
          const parts = [
            row.open > 0 ? fill(t('MyDay.countOpen'), { count: row.open }) : null,
            row.late > 0 ? fill(t('MyDay.countLate'), { count: row.late }) : null,
            row.waitingOnYou > 0
              ? fill(t('MyDay.countWaiting'), { count: row.waitingOnYou })
              : null,
            row.waitingOnOthers > 0
              ? fill(t('MyDay.countWaitingOthers'), { count: row.waitingOnOthers })
              : null,
          ].filter((part): part is string => part !== null);
          const listed = row.entries.slice(0, LIST_ROWS.wide - 1);
          return (
            <li key={row.projectId} className="tm-myday-project" data-open={expanded || undefined}>
              <button
                type="button"
                className="tm-myday-project__toggle"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setOpen(expanded ? null : row.projectId)}
              >
                <NavIcon name="forward" size={16} className="tm-myday-project__chevron" />
                <span className="tm-myday-project__name">{ctx.projectName(row.projectId)}</span>
                <span className="tm-myday-project__counts">{parts.join(' · ')}</span>
                <span className="tm-myday-project__due">
                  {row.nextDue ? dueLabel(tOr, locale, row.nextDue, ctx.now) : ''}
                </span>
              </button>
              <div id={panelId} hidden={!expanded} className="tm-myday-project__items">
                <ul>
                  {listed.map((entry) => (
                    <li key={entry.workItem.id} className="tm-myday-project__item">
                      <Link href={`/${ctx.slug}/work/${encodeURIComponent(entry.workItem.id)}`}>
                        {entry.workItem.title}
                      </Link>
                      <DueChip entry={entry} now={ctx.now} />
                    </li>
                  ))}
                </ul>
                {/* R5: an open row that lists fewer tasks than its count ends with "All (n)". */}
                {listed.length < row.open ? (
                  <AllLink
                    href={`/${ctx.slug}/projects/${encodeURIComponent(row.projectId)}`}
                    count={row.open}
                    label={ctx.projectName(row.projectId)}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </MyDayWidget>
  );
}
