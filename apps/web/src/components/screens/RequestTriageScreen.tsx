'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { AcceptRequestDialog, type AcceptRequestChoice } from '../requests/AcceptRequestDialog';
import {
  addDays,
  DueDatePicker,
  formatChipDay,
  isArabic,
  todayOf,
  useA6T,
} from '../work/DueDatePicker';
import { firstNameOf } from '../work/OwnerPickerDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  acceptClientRequest,
  deferClientRequest,
  getClientRequestRecord,
  listClientRequestRecords,
  MAX_CLIENT_REQUEST_PAGE,
  reopenClientRequest,
  transitionClientRequest,
} from '../../lib/api/client-requests';
import type { ClientRequestRecord, ClientRequestState } from '../../lib/api/client-requests';
import { listProjects } from '../../lib/api/projects';
import { listRequestMessages, postRequestMessage } from '../../lib/api/request-messages';
import type { RequestMessageView } from '../../lib/api/request-messages';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { workItemKeys } from '../../lib/query-keys';
import './request-triage.css';
import { appDateLocale } from '../../lib/i18n/app-locale';

const RLM = '‏';

export interface RequestTriageScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The request the page opened on; the list chooses others in place. */
  clientRequestId: string;
  client?: ApiClient;
  /** Injected in tests; the reader's clock otherwise. */
  now?: Date;
}

type Tab = 'new' | 'deferred' | 'accepted' | 'declined';

const TAB_STATES: Record<Tab, readonly ClientRequestState[]> = {
  // Everything the studio still has to decide: a request nobody opened, one being triaged, and
  // one whose clarification came back. Accept / Decline / Defer each route through `triage`.
  new: ['submitted', 'triage', 'needs_clarification'],
  deferred: ['deferred'],
  accepted: ['accepted', 'planned', 'delivered'],
  declined: ['declined', 'withdrawn'],
};

const TAB_KEY: Record<Tab, string> = {
  new: 'RequestTriageA7.tabNew',
  deferred: 'RequestTriageA7.tabDeferred',
  accepted: 'RequestTriageA7.tabAccepted',
  declined: 'RequestTriageA7.tabDeclined',
};

const STATE_KEY: Partial<Record<ClientRequestState, string>> = {
  accepted: 'RequestTriageA7.stateAccepted',
  planned: 'RequestTriageA7.statePlanned',
  delivered: 'RequestTriageA7.stateDelivered',
  declined: 'RequestTriageA7.stateDeclined',
  withdrawn: 'RequestTriageA7.stateWithdrawn',
};

function tabOf(state: ClientRequestState): Tab {
  return (Object.keys(TAB_STATES) as Tab[]).find((tab) => TAB_STATES[tab].includes(state)) ?? 'new';
}

/** "YA" for "Youssef Adel"; one letter for Arabic script, the way the catalog draws it. */
function orbOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  if (/[؀-ۿ]/.test(first)) return first;
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function intlLocale(locale: string): string {
  return appDateLocale(isArabic(locale) ? locale : 'en-GB');
}

/** "2h" · "1d" in English; "ساعتان" · "3 أيام" in Arabic — the list's age column. */
export function ageOf(createdAt: string, now: Date, locale: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  const [value, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 60 * 24
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.floor(minutes / 1440), 'day'];
  const arabic = isArabic(locale);
  const text = new Intl.NumberFormat(intlLocale(locale), {
    style: 'unit',
    unit,
    unitDisplay: arabic ? 'long' : 'narrow',
  }).format(value);
  // Arabic's singular day reads as the bare noun in the catalog ("يوم").
  return arabic && value === 1 && unit === 'day' ? 'يوم' : text.replace(/\s+/g, arabic ? ' ' : '');
}

/** "2 hours ago" · "قبل ساعتين" — the detail's "sent …" line. */
function agoOf(createdAt: string, now: Date, locale: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  const format = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'always' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  if (minutes < 60 * 24) return format.format(-Math.floor(minutes / 60), 'hour');
  return format.format(-Math.floor(minutes / 1440), 'day');
}

/**
 * **Requests — triage (A7, Figma fq9-triage).**
 *
 * "Requests / Client requests waiting for a decision" with Project and Client filters; tabs New
 * (n) · Deferred (n) · Accepted · Declined; the list on one side (sender orb and name, client,
 * title, project chip, age — and under New, the Deferred group with its "Back on <date>" pill and
 * "Reopen now"); the chosen request on the other with Accept (opens the confirm dialog) and
 * Decline, the grey "Defer until" panel (date chip, Defer, "Reopen it on this date and remind
 * me") and "Reply to <first name>", which posts a client-visible message on the request's thread.
 * Above the reply box the request's conversation is listed (read-only, oldest first) once it has
 * messages, so the studio reads the client's answers where it replies (PLAN A7: the thread is
 * embedded, the reply box is the composer).
 */
export function RequestTriageScreen({
  organizationSlug,
  organizationName,
  clientRequestId,
  client,
  now,
}: RequestTriageScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useA6T();
  const locale = useActiveLocale();
  const clock = useMemo(() => now ?? new Date(), [now]);
  const rtl = isArabic(locale) ? RLM : '';

  const [tab, setTab] = useState<Tab | null>(null);
  const [selectedId, setSelectedId] = useState(clientRequestId);
  const [projectFilter, setProjectFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');

  const listKey = ['client-requests', organizationSlug, 'triage-a7'] as const;
  const requests = useQuery({
    queryKey: listKey,
    queryFn: () =>
      listClientRequestRecords(api, organizationSlug, { limit: MAX_CLIENT_REQUEST_PAGE }),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const selected = useQuery({
    queryKey: ['client-request', organizationSlug, selectedId],
    queryFn: () => getClientRequestRecord(api, organizationSlug, selectedId),
    enabled: selectedId !== '',
  });

  const projectName = (id: string) =>
    (projects.data ?? []).find((project) => project.id === id)?.name ?? '';
  const all = requests.data ?? [];
  const clients = [
    ...new Map(
      all
        .filter((row) => row.clientOrganizationName !== null)
        .map((row) => [row.clientOrganizationId, row.clientOrganizationName as string]),
    ),
  ];
  const filtered = all.filter(
    (row) =>
      (projectFilter === '' || row.projectId === projectFilter) &&
      (clientFilter === '' || row.clientOrganizationId === clientFilter),
  );
  const inTab = (which: Tab) => filtered.filter((row) => TAB_STATES[which].includes(row.state));
  const current = selected.data ?? all.find((row) => row.id === selectedId);
  const activeTab: Tab = tab ?? (current ? tabOf(current.state) : 'new');

  async function refresh(updated?: ClientRequestRecord) {
    if (updated) queries.setQueryData(['client-request', organizationSlug, updated.id], updated);
    await queries.invalidateQueries({ queryKey: ['client-requests', organizationSlug] });
  }

  function chooseTab(next: Tab) {
    setTab(next);
    const first = inTab(next)[0];
    if (first) setSelectedId(first.id);
  }

  async function reopen(row: ClientRequestRecord) {
    const updated = await reopenClientRequest(api, organizationSlug, row.id, row.version);
    await refresh(updated);
  }

  const list = inTab(activeTab);
  const deferredGroup = activeTab === 'new' ? inTab('deferred') : [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title={t('RequestTriageA7.title')}
      description={t('RequestTriageA7.subtitle')}
      actions={
        <div className="tm-rq-filters">
          <label className="tm-rq-filter">
            <select
              value={projectFilter}
              aria-label={t('AcceptRequest.project')}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">
                {t('RequestTriageA7.projectFilter', { value: t('RequestTriageA7.all') })}
              </option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {t('RequestTriageA7.projectFilter', { value: project.name })}
                </option>
              ))}
            </select>
          </label>
          <label className="tm-rq-filter">
            <select
              value={clientFilter}
              aria-label={t('RequestTriageA7.clientLabel')}
              onChange={(event) => setClientFilter(event.target.value)}
            >
              <option value="">
                {t('RequestTriageA7.clientFilter', { value: t('RequestTriageA7.all') })}
              </option>
              {clients.map(([id, name]) => (
                <option key={id} value={id}>
                  {t('RequestTriageA7.clientFilter', { value: name })}
                </option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      <div
        className="tm-wk-tabs tm-rq-tabs"
        role="tablist"
        aria-label={t('RequestTriageA7.tabsLabel')}
      >
        {(Object.keys(TAB_STATES) as Tab[]).map((which) => {
          const count = inTab(which).length;
          return (
            <button
              key={which}
              type="button"
              role="tab"
              aria-selected={activeTab === which}
              onClick={() => chooseTab(which)}
            >
              {t(TAB_KEY[which])}
              {(which === 'new' || which === 'deferred') && count > 0 ? (
                <span className="tm-wk-count">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {requests.isError ? (
        <InlineAlert tone="danger" title={t('RequestTriageA7.loadFailed')} live>
          {t('RequestTriageA7.failed')}
        </InlineAlert>
      ) : null}

      {requests.isPending ? (
        <LoadingRegion label={t('RequestTriageA7.loading')}>
          <Skeleton height="420px" />
        </LoadingRegion>
      ) : (
        <div className="tm-rq-layout">
          <section className="tm-rq-list" aria-label={t('RequestTriageA7.listLabel')}>
            {list.length === 0 && deferredGroup.length === 0 ? (
              <p className="tm-rq-empty">
                {activeTab === 'new'
                  ? t('RequestTriageA7.emptyNew')
                  : t('RequestTriageA7.emptyTab')}
              </p>
            ) : null}
            <ul className="tm-rq-rows">
              {list.map((row) => (
                <RequestRow
                  key={row.id}
                  row={row}
                  selected={row.id === selectedId}
                  projectName={projectName(row.projectId)}
                  age={ageOf(row.createdAt, clock, locale)}
                  rtl={rtl}
                  onChoose={() => setSelectedId(row.id)}
                  {...(row.state === 'deferred' ? { onReopen: () => void reopen(row) } : {})}
                />
              ))}
            </ul>
            {deferredGroup.length > 0 ? (
              <div className="tm-rq-group">
                <h2 className="tm-rq-group__title">{t('RequestTriageA7.deferredGroup')}</h2>
                <ul className="tm-rq-rows">
                  {deferredGroup.map((row) => (
                    <RequestRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      projectName={projectName(row.projectId)}
                      age={ageOf(row.createdAt, clock, locale)}
                      rtl={rtl}
                      onChoose={() => setSelectedId(row.id)}
                      onReopen={() => void reopen(row)}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {current ? (
            <RequestDetail
              key={current.id}
              api={api}
              organizationSlug={organizationSlug}
              studioName={organizationName}
              request={current}
              projectName={projectName(current.projectId)}
              clock={clock}
              onChanged={refresh}
              onReopen={() => void reopen(current)}
            />
          ) : (
            <section className="tm-rq-detail tm-rq-detail--empty">
              <p className="tm-rq-empty">{t('RequestTriageA7.chooseRequest')}</p>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function senderOf(row: ClientRequestRecord, fallback: string): string {
  return row.submittedByName ?? row.clientOrganizationName ?? fallback;
}

interface RequestRowProps {
  row: ClientRequestRecord;
  selected: boolean;
  projectName: string;
  age: string;
  rtl: string;
  onChoose: () => void;
  onReopen?: () => void;
}

function RequestRow({ row, selected, projectName, age, rtl, onChoose, onReopen }: RequestRowProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const sender = senderOf(row, t('RequestTriageA7.theClient'));
  return (
    <li className="tm-rq-row" data-selected={selected || undefined}>
      <button
        type="button"
        className="tm-rq-row__main"
        aria-current={selected ? 'true' : undefined}
        onClick={onChoose}
      >
        <span className="tm-rq-orb" aria-hidden="true">
          {orbOf(sender)}
        </span>
        <span className="tm-rq-row__who">
          <span className="tm-rq-row__name">{sender}</span>
          {row.clientOrganizationName !== null ? (
            <span className="tm-rq-row__org">{row.clientOrganizationName}</span>
          ) : null}
        </span>
        <span className="tm-rq-row__age">{age}</span>
        <span className="tm-rq-row__title">{row.title}</span>
        {projectName !== '' ? <span className="tm-rq-chip">{projectName}</span> : null}
      </button>
      {row.state === 'deferred' && onReopen ? (
        <div className="tm-rq-row__deferred">
          {row.deferUntil !== null ? (
            <span className="tm-rq-pill">
              <span className="tm-rq-pill__dot" aria-hidden="true" />
              {rtl}
              {t('RequestTriageA7.backOn', { date: formatChipDay(row.deferUntil, locale) })}
            </span>
          ) : (
            <span />
          )}
          <button type="button" className="tm-rq-link" onClick={onReopen}>
            {t('RequestTriageA7.reopenNow')}
          </button>
        </div>
      ) : null}
    </li>
  );
}

interface RequestDetailProps {
  api: ApiClient;
  organizationSlug: string;
  studioName: string;
  request: ClientRequestRecord;
  projectName: string;
  clock: Date;
  onChanged: (updated?: ClientRequestRecord) => Promise<void>;
  onReopen: () => void;
}

function RequestDetail({
  api,
  organizationSlug,
  studioName,
  request,
  projectName,
  clock,
  onChanged,
  onReopen,
}: RequestDetailProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const rtl = isArabic(locale) ? RLM : '';
  const sender = senderOf(request, t('RequestTriageA7.theClient'));
  const firstName = firstNameOf(sender);
  const clientName = request.clientOrganizationName ?? t('RequestTriageA7.theClient');

  const [deferDay, setDeferDay] = useState(addDays(todayOf(clock), 7));
  const [picking, setPicking] = useState(false);
  const [remind, setRemind] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [reply, setReply] = useState('');
  const [replied, setReplied] = useState(false);
  const [working, setWorking] = useState<'accept' | 'decline' | 'defer' | 'reply' | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [acceptedWork, setAcceptedWork] = useState<string | undefined>(undefined);

  const open = TAB_STATES.new.includes(request.state);

  /** Accept, Decline and Defer all leave from `triage`; a fresh or answered request goes there first. */
  async function inTriage(): Promise<ClientRequestRecord> {
    if (request.state === 'triage') return request;
    return transitionClientRequest(api, organizationSlug, request.id, request.version, {
      to: 'triage',
    });
  }

  async function act(
    which: 'accept' | 'decline' | 'defer' | 'reply',
    work: () => Promise<ClientRequestRecord | undefined>,
  ) {
    setFailure(undefined);
    setWorking(which);
    try {
      const updated = await work();
      await onChanged(updated);
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError && error.status === 409
          ? t('RequestTriageA7.conflict')
          : t('RequestTriageA7.failed'),
      );
    } finally {
      setWorking(null);
    }
  }

  function accept(choice: AcceptRequestChoice) {
    void act('accept', async () => {
      const ready = await inTriage();
      const result = await acceptClientRequest(api, organizationSlug, request.id, {
        version: ready.version,
        clientSafeScopeSummary: request.title,
        commitment: choice.dueDay === '' ? 'unscheduled' : choice.dueDay,
        ...(choice.ownerUserId === null ? {} : { work: { ownerUserId: choice.ownerUserId } }),
        ...(choice.notifyClient ? {} : { notifyClient: false }),
      });
      setAccepting(false);
      setAcceptedWork(result.workItemId);
      await queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      return result.request;
    });
  }

  function decline() {
    void act('decline', async () => {
      const ready = await inTriage();
      const updated = await transitionClientRequest(
        api,
        organizationSlug,
        request.id,
        ready.version,
        {
          to: 'declined',
          clientVisibleReason: declineReason.trim(),
        },
      );
      setDeclining(false);
      return updated;
    });
  }

  function defer() {
    void act('defer', async () => {
      const ready = await inTriage();
      return deferClientRequest(api, organizationSlug, request.id, {
        version: ready.version,
        clientVisibleReason: t('RequestTriageA7.deferReason', {
          date: formatChipDay(deferDay, locale),
        }),
        deferUntil: deferDay,
        remindOnReopen: remind,
      });
    });
  }

  function sendReply() {
    const body = reply.trim();
    if (body === '') return;
    void act('reply', async () => {
      await postRequestMessage(api, organizationSlug, request.id, { body, clientVisible: true });
      setReply('');
      setReplied(true);
      await queries.invalidateQueries({
        queryKey: ['request-messages', 'team', organizationSlug, request.id],
      });
      return undefined;
    });
  }

  const stateKey = STATE_KEY[request.state];

  return (
    <section className="tm-rq-detail" aria-labelledby="tm-rq-detail-title">
      <header className="tm-rq-detail__head">
        <span className="tm-rq-orb" aria-hidden="true">
          {orbOf(sender)}
        </span>
        <span className="tm-rq-row__who">
          <span className="tm-rq-row__name">{sender}</span>
          <span className="tm-rq-row__org">
            {rtl}
            {clientName} ·{' '}
            {t('RequestTriageA7.sentAgo', { ago: agoOf(request.createdAt, clock, locale) })}
          </span>
        </span>
        {projectName !== '' ? <span className="tm-rq-chip">{projectName}</span> : null}
      </header>

      <h2 id="tm-rq-detail-title" className="tm-rq-detail__title">
        {request.title}
      </h2>
      <p className="tm-rq-detail__prose">{request.description}</p>

      {acceptedWork !== undefined ? (
        <InlineAlert tone="success" title={t('RequestTriageA7.acceptedNotice')} live>
          <Link href={`/${organizationSlug}/work/${acceptedWork}`}>
            {t('RequestTriageA7.openWorkItem')}
          </Link>
        </InlineAlert>
      ) : null}

      {open ? (
        <>
          <div className="tm-rq-actions">
            <Button
              tone="ink"
              size="accessible"
              loading={working === 'accept'}
              loadingLabel={t('AcceptRequest.accepting')}
              onClick={() => setAccepting(true)}
            >
              {t('RequestTriageA7.accept')}
            </Button>
            <button
              type="button"
              className="tm-rq-link tm-rq-link--quiet"
              aria-expanded={declining}
              onClick={() => setDeclining((value) => !value)}
            >
              {t('RequestTriageA7.decline')}
            </button>
          </div>

          {declining ? (
            <div className="tm-rq-decline">
              <label className="tm-field__label" htmlFor="tm-rq-decline-reason">
                {t('RequestTriageA7.declineWhy', { name: firstName })}
              </label>
              <textarea
                id="tm-rq-decline-reason"
                className="tm-field__control tm-rq-textarea"
                rows={2}
                maxLength={1000}
                value={declineReason}
                onChange={(event) => setDeclineReason(event.target.value)}
              />
              <div className="tm-rq-decline__buttons">
                <Button tone="outline" onClick={() => setDeclining(false)}>
                  {t('RequestTriageA7.cancel')}
                </Button>
                <Button
                  tone="destructive"
                  disabled={declineReason.trim() === ''}
                  loading={working === 'decline'}
                  loadingLabel={t('RequestTriageA7.sending')}
                  onClick={decline}
                >
                  {t('RequestTriageA7.declineConfirm')}
                </Button>
              </div>
            </div>
          ) : null}

          <fieldset className="tm-rq-defer">
            <legend className="tm-rq-defer__title">{t('RequestTriageA7.deferUntil')}</legend>
            <div className="tm-rq-defer__row">
              <div className="tm-wk-popover-anchor">
                <button
                  type="button"
                  className="tm-wk-fact"
                  aria-haspopup="dialog"
                  aria-expanded={picking}
                  onClick={() => setPicking((value) => !value)}
                >
                  <span className="tm-wk-fact__text">
                    <span className="tm-wk-fact__label">{t('RequestTriageA7.date')}</span>
                    <span className="tm-wk-fact__value">{formatChipDay(deferDay, locale)}</span>
                  </span>
                  <span className="tm-wk-fact__caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {picking ? (
                  <DueDatePicker
                    heading={t('RequestTriageA7.pickDate')}
                    value={deferDay}
                    now={clock}
                    min={addDays(todayOf(clock), 1)}
                    onSet={(day) => {
                      if (day !== null) setDeferDay(day);
                      setPicking(false);
                    }}
                    onClose={() => setPicking(false)}
                  />
                ) : null}
              </div>
              <Button
                tone="outline"
                size="accessible"
                loading={working === 'defer'}
                loadingLabel={t('RequestTriageA7.sending')}
                onClick={defer}
              >
                {t('RequestTriageA7.defer')}
              </Button>
            </div>
            <Checkbox
              label={t('RequestTriageA7.remind')}
              checked={remind}
              onChange={(event) => setRemind(event.target.checked)}
            />
          </fieldset>
        </>
      ) : request.state === 'deferred' ? (
        <div className="tm-rq-row__deferred">
          {request.deferUntil !== null ? (
            <span className="tm-rq-pill">
              <span className="tm-rq-pill__dot" aria-hidden="true" />
              {t('RequestTriageA7.backOn', { date: formatChipDay(request.deferUntil, locale) })}
            </span>
          ) : (
            <span />
          )}
          <button type="button" className="tm-rq-link" onClick={onReopen}>
            {t('RequestTriageA7.reopenNow')}
          </button>
        </div>
      ) : stateKey !== undefined ? (
        <p className="tm-rq-state">{t(stateKey)}</p>
      ) : null}

      <RequestConversation
        api={api}
        organizationSlug={organizationSlug}
        clientRequestId={request.id}
        studioName={studioName}
        clientName={clientName}
      />

      <div className="tm-rq-reply">
        <label className="tm-rq-reply__label" htmlFor="tm-rq-reply-body">
          {t('RequestTriageA7.replyTo', { name: firstName })}
        </label>
        <textarea
          id="tm-rq-reply-body"
          className="tm-field__control tm-rq-reply__body"
          rows={1}
          maxLength={10000}
          value={reply}
          aria-describedby="tm-rq-reply-hint"
          onChange={(event) => {
            setReply(event.target.value);
            setReplied(false);
          }}
        />
        <p className="tm-rq-reply__hint" id="tm-rq-reply-hint">
          {replied
            ? t('RequestTriageA7.replySent')
            : t('RequestTriageA7.replyHint', { name: firstName })}
        </p>
        <div className="tm-rq-reply__send">
          <Button
            tone="ink"
            size="accessible"
            disabled={reply.trim() === ''}
            loading={working === 'reply'}
            loadingLabel={t('RequestTriageA7.sending')}
            onClick={sendReply}
          >
            {t('RequestTriageA7.sendReply')}
          </Button>
        </div>
      </div>

      {failure ? (
        <InlineAlert tone="danger" live>
          {failure}
        </InlineAlert>
      ) : null}

      {accepting ? (
        <AcceptRequestDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={request.projectId}
          projectName={projectName}
          requestTitle={request.title}
          senderName={sender}
          clientName={clientName}
          initialDueDay={request.desiredAt ?? ''}
          saving={working === 'accept'}
          onAccept={accept}
          onClose={() => setAccepting(false)}
        />
      ) : null}
    </section>
  );
}

interface RequestConversationProps {
  api: ApiClient;
  organizationSlug: string;
  clientRequestId: string;
  studioName: string;
  clientName: string;
}

/**
 * The request's conversation, read-only: what the studio and the client have written on it,
 * oldest first. It shares its query key with the reply box (`request-messages` · `team`), so a
 * sent reply lands here; an internal note carries its tag. Hidden until there is a message, so
 * a fresh request looks exactly like fq9-triage.
 */
function RequestConversation({
  api,
  organizationSlug,
  clientRequestId,
  studioName,
  clientName,
}: RequestConversationProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const messages = useQuery({
    queryKey: ['request-messages', 'team', organizationSlug, clientRequestId],
    queryFn: () => listRequestMessages(api, organizationSlug, clientRequestId),
  });
  const rows: readonly RequestMessageView[] = messages.data ?? [];
  if (rows.length === 0) return null;
  const rtl = isArabic(locale) ? RLM : '';
  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <section className="tm-rq-convo" aria-labelledby="tm-rq-convo-title">
      <h3 id="tm-rq-convo-title" className="tm-rq-convo__title">
        {t('RequestMessages.headingTeam')}
      </h3>
      <ol className="tm-rq-convo__list" aria-label={t('RequestMessages.listLabel')}>
        {rows.map((message) => {
          const author =
            message.authorName ?? (message.authorKind === 'internal' ? studioName : clientName);
          return (
            <li key={message.id} className="tm-rq-convo__msg" data-from={message.authorKind}>
              <span className="tm-rq-orb" aria-hidden="true">
                {orbOf(author)}
              </span>
              <div className="tm-rq-convo__main">
                <div className="tm-rq-convo__head">
                  <span className="tm-rq-row__name">
                    {rtl}
                    {author}
                  </span>
                  <time className="tm-rq-row__age" dateTime={message.createdAt}>
                    {time.format(new Date(message.createdAt))}
                  </time>
                  {message.clientVisible ? null : (
                    <span className="tm-rq-convo__tag">{t('RequestMessages.internalNote')}</span>
                  )}
                </div>
                <p className="tm-rq-convo__body">{message.body}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
