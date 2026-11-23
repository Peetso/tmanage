'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton, StateCapsule, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  AI_ADMIN_POOLS,
  declineAiPackRequest,
  fetchAiBudget,
  fetchAiTestList,
  pauseAi,
  resumeAi,
  updateAiBudget,
} from '../../../lib/api/ai-spend';
import type {
  AiAdminPool,
  AiBudgetView,
  AiPackRequestQueueView,
  AiTestListEntryView,
  AiTestListView,
} from '../../../lib/api/ai-spend';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { creditsTone } from '../../../lib/api/ai-credits';
import { useT } from '../../../lib/i18n/use-t';
import { useAiText } from '../../ai-chat/use-ai-text';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import {
  AI_BUDGET_KEY,
  AI_TEST_LIST_KEY,
  AddWorkspaceDialog,
  ChangeCapDialog,
  GrantDialog,
  POOL_LABEL,
  ReleaseReserveDialog,
  WorkspaceOptionsDialog,
} from './AiSpendDialogs';
import { centsOf, monthTotals, overCap, percent, poolRow, usd } from './ai-spend-model';
import '../../ai-chat/ai-chat.css';
import './ai-spend.css';
import { withNumerals } from '../../../lib/i18n/display-format';

/**
 * Platform admin › AI spend (plan 62-19; Figma G13 v2 784:48078, resumed state 784:49225, dialogs
 * 785:48413–785:49122). Shows the month's spend against the server's ceiling and lets a platform
 * admin with `platform.settings.edit` move caps, switch detailed answers, pause AI, release
 * reserve, keep the test list and answer pack requests. Every figure comes from the API (AR-9);
 * every change carries a reason the server writes to the platform log (DA-11).
 */
export function AiSpendScreen({ client, now }: ScreenProps & { readonly now?: () => Date }) {
  const api = client ?? browserApiClient();
  const t = useT();
  const { t: at } = useAiText();
  return (
    <PlatformGate
      api={api}
      section="ai-spend"
      crumbs={[at('AiSpend.title')]}
      title={at('AiSpend.title')}
      description={at('AiSpend.lead')}
    >
      {(me) => <AiSpendBody api={api} me={me} t={t} {...(now ? { now } : {})} />}
    </PlatformGate>
  );
}

type Dialog =
  | { readonly kind: 'cap'; readonly pool: AiAdminPool }
  | { readonly kind: 'sonnet' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'release' }
  | { readonly kind: 'add' }
  | { readonly kind: 'options'; readonly entry: AiTestListEntryView }
  | {
      readonly kind: 'grant';
      readonly entry: Pick<AiTestListEntryView, 'organizationId' | 'name'>;
      readonly request: AiPackRequestQueueView;
    }
  | {
      readonly kind: 'decline';
      readonly entry: Pick<AiTestListEntryView, 'organizationId' | 'name'>;
      readonly request: AiPackRequestQueueView;
    };

function AiSpendBody({
  api,
  me,
  t,
  now,
}: {
  readonly api: ApiClient;
  readonly me: PlatformMeView;
  readonly t: ReturnType<typeof useT>;
  readonly now?: () => Date;
}) {
  const text = useAiText();
  const queryClient = useQueryClient();
  const budget = useQuery({ queryKey: AI_BUDGET_KEY, queryFn: () => fetchAiBudget(api) });
  const testList = useQuery({ queryKey: AI_TEST_LIST_KEY, queryFn: () => fetchAiTestList(api) });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLElement | null>(null);

  function open(next: Dialog) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  }

  function close(done: boolean, message: string) {
    setDialog(null);
    if (done) setNotice(message);
    // Focus goes back to the control that opened the dialog (UX-15).
    queueMicrotask(() => opener.current?.focus());
  }

  if (budget.isPending) {
    return (
      <div className="tm-ais" aria-busy="true">
        <p className="tm-visually-hidden">{text.t('AiSpend.loading')}</p>
        <Skeleton height="var(--s24)" />
        <Skeleton height="var(--s24)" />
      </div>
    );
  }
  if (budget.isError) {
    return (
      <InlineAlert tone="danger" title={text.t('AiSpend.loadError')} live>
        {platformErrorText(budget.error, t)}{' '}
        <Button type="button" tone="text" onClick={() => void budget.refetch()}>
          {text.t('AiSpend.retry')}
        </Button>
      </InlineAlert>
    );
  }

  const view = budget.data;
  const list = testList.data ?? null;
  const names = new Map(list?.workspaces.map((entry) => [entry.organizationId, entry.name]) ?? []);
  const nameOf = (organizationId: string) => names.get(organizationId) ?? organizationId;

  return (
    <div className="tm-ais">
      <p className="tm-visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      <PausedBanner view={view} />
      <Stats view={view} list={list} />
      <div className="tm-ais-grid">
        <CapsCard view={view} onChange={(pool) => open({ kind: 'cap', pool })} />
        <ControlsCard
          view={view}
          onSonnet={() => open({ kind: 'sonnet' })}
          onPause={() => open({ kind: view.paused ? 'resume' : 'pause' })}
          onRelease={() => open({ kind: 'release' })}
        />
        <TestListCard
          query={testList}
          onAdd={() => open({ kind: 'add' })}
          onOptions={(entry) => open({ kind: 'options', entry })}
        />
        <PackRequestsCard
          list={list}
          nameOf={nameOf}
          onGrant={(request) =>
            open({
              kind: 'grant',
              request,
              entry: {
                organizationId: request.organizationId,
                name: nameOf(request.organizationId),
              },
            })
          }
          onDecline={(request) =>
            open({
              kind: 'decline',
              request,
              entry: {
                organizationId: request.organizationId,
                name: nameOf(request.organizationId),
              },
            })
          }
        />
      </div>

      {dialog?.kind === 'cap' ? (
        <ChangeCapDialog
          api={api}
          view={view}
          pool={dialog.pool}
          onClose={(done) => close(done, text.t('AiSpend.done.cap'))}
        />
      ) : null}
      {dialog?.kind === 'sonnet' ? (
        <ReasonDialog
          title={text.t(view.sonnetEnabled ? 'AiSpend.sonnet.offTitle' : 'AiSpend.sonnet.onTitle')}
          body={text.t(view.sonnetEnabled ? 'AiSpend.sonnet.offBody' : 'AiSpend.sonnet.onBody')}
          reasonRequired
          confirmLabel={text.t(
            view.sonnetEnabled ? 'AiSpend.sonnet.offConfirm' : 'AiSpend.sonnet.onConfirm',
          )}
          note={text.t('AiSpend.reasonHint')}
          onConfirm={async (reason) => {
            const next = await updateAiBudget(api, {
              customersCents: centsOf(view.capsMicroUsd.customers),
              testingCents: centsOf(view.capsMicroUsd.testing),
              reserveCents: centsOf(view.capsMicroUsd.reserve),
              sonnetEnabled: !view.sonnetEnabled,
              applyTo: 'this_month',
              reason: reason ?? '',
            });
            queryClient.setQueryData(AI_BUDGET_KEY, next);
          }}
          onClose={(done) => close(done, text.t('AiSpend.done.sonnet'))}
        />
      ) : null}
      {dialog?.kind === 'pause' || dialog?.kind === 'resume' ? (
        <ReasonDialog
          title={text.t(dialog.kind === 'pause' ? 'AiSpend.pause.title' : 'AiSpend.resume.title')}
          body={text.t(dialog.kind === 'pause' ? 'AiSpend.pause.body' : 'AiSpend.resume.body')}
          reasonRequired
          destructive={dialog.kind === 'pause'}
          confirmLabel={text.t(
            dialog.kind === 'pause' ? 'AiSpend.pause.confirm' : 'AiSpend.resume.confirm',
          )}
          note={text.t('AiSpend.reasonHint')}
          onConfirm={async (reason) => {
            const next =
              dialog.kind === 'pause'
                ? await pauseAi(api, reason ?? '')
                : await resumeAi(api, reason ?? '');
            queryClient.setQueryData(AI_BUDGET_KEY, next);
          }}
          onClose={(done) =>
            close(
              done,
              text.t(dialog.kind === 'pause' ? 'AiSpend.done.paused' : 'AiSpend.done.resumed'),
            )
          }
        />
      ) : null}
      {dialog?.kind === 'release' ? (
        <ReleaseReserveDialog
          api={api}
          view={view}
          me={me}
          {...(now ? { now } : {})}
          onClose={(done) => close(done, text.t('AiSpend.done.released'))}
        />
      ) : null}
      {dialog?.kind === 'add' ? (
        <AddWorkspaceDialog
          api={api}
          listed={new Set(names.keys())}
          onClose={(done) => close(done, text.t('AiSpend.done.added'))}
        />
      ) : null}
      {dialog?.kind === 'options' ? (
        <WorkspaceOptionsDialog
          api={api}
          entry={dialog.entry}
          onClose={(done) => close(done, text.t('AiSpend.done.workspace'))}
        />
      ) : null}
      {dialog?.kind === 'grant' ? (
        <GrantDialog
          api={api}
          entry={dialog.entry}
          request={dialog.request}
          maxPackCredits={list?.maxPackCredits ?? 10000}
          onClose={(done) => close(done, text.t('AiSpend.done.granted'))}
        />
      ) : null}
      {dialog?.kind === 'decline' ? (
        <ReasonDialog
          title={text.t('AiSpend.decline.title', { name: dialog.entry.name })}
          body={text.t('AiSpend.decline.body')}
          reasonRequired={false}
          destructive
          confirmLabel={text.t('AiSpend.decline.confirm')}
          note={text.t('AiSpend.reasonHint')}
          onConfirm={async (reason) => {
            await declineAiPackRequest(api, dialog.entry.organizationId, dialog.request.id, reason);
            await queryClient.invalidateQueries({ queryKey: AI_TEST_LIST_KEY });
          }}
          onClose={(done) => close(done, text.t('AiSpend.done.declined'))}
        />
      ) : null}
    </div>
  );
}

/** Figma 784:49225: AI on again with one pool still paused by its cap. */
function PausedBanner({ view }: { readonly view: AiBudgetView }) {
  const { t } = useAiText();
  if (view.paused) {
    return (
      <InlineAlert tone="warning" title={t('AiSpend.banner.pausedTitle')} live>
        {t('AiSpend.banner.pausedBody')}
      </InlineAlert>
    );
  }
  const stuck = AI_ADMIN_POOLS.filter((pool) => overCap(poolRow(view, pool)));
  if (stuck.length === 0) return null;
  return (
    <InlineAlert tone="warning" live>
      {stuck.map((pool) => t('AiSpend.banner.overCap', { pool: t(POOL_LABEL[pool]) })).join(' ')}
    </InlineAlert>
  );
}

function Stats({
  view,
  list,
}: {
  readonly view: AiBudgetView;
  readonly list: AiTestListView | null;
}) {
  const { t, number, plural, locale } = useAiText();
  const { spent, held } = monthTotals(view);
  const testing = list?.workspaces.filter((entry) => entry.poolClass === 'testing').length ?? 0;
  return (
    <dl className="tm-ais-stats">
      <div className="tm-ais-stat">
        <dt>{t('AiSpend.stat.spent')}</dt>
        <dd className="tm-ais-stat__value">{usd(spent, locale)}</dd>
        <dd className="tm-ais-stat__note">
          {t('AiSpend.stat.spentNote', {
            ceiling: usd(view.ceilingMicroUsd, locale),
            percent: number(percent(spent, view.ceilingMicroUsd)),
          })}
        </dd>
      </div>
      <div className="tm-ais-stat">
        <dt>{t('AiSpend.stat.held')}</dt>
        <dd className="tm-ais-stat__value">{usd(held, locale)}</dd>
        <dd className="tm-ais-stat__note">{t('AiSpend.stat.heldNote')}</dd>
      </div>
      <div className="tm-ais-stat">
        <dt>{t('AiSpend.stat.testList')}</dt>
        <dd className="tm-ais-stat__value">{list ? number(list.workspaces.length) : '–'}</dd>
        <dd className="tm-ais-stat__note">
          {list
            ? plural('AiSpend.stat.testListNote', testing, {
                one: '{count} pays from Testing',
                other: '{count} pay from Testing',
              })
            : ''}
        </dd>
      </div>
      <div className="tm-ais-stat">
        <dt>{t('AiSpend.stat.requests')}</dt>
        <dd className="tm-ais-stat__value">{list ? number(list.openRequests.length) : '–'}</dd>
        <dd className="tm-ais-stat__note">{t('AiSpend.stat.requestsNote')}</dd>
      </div>
    </dl>
  );
}

function CapsCard({
  view,
  onChange,
}: {
  readonly view: AiBudgetView;
  readonly onChange: (pool: AiAdminPool) => void;
}) {
  const { t, locale } = useAiText();
  const month = new Intl.DateTimeFormat(withNumerals(locale), {
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(view.periodStart));
  return (
    <section className="tm-ais-card" aria-labelledby="ais-caps">
      <header className="tm-ais-card__head">
        <h2 id="ais-caps" className="tm-ais-card__title">
          {t('AiSpend.caps.title')}
        </h2>
        <span className="tm-ais-muted">{t('AiSpend.caps.period', { month })}</span>
      </header>
      <ul className="tm-ais-rows">
        {AI_ADMIN_POOLS.map((pool) => {
          const row = poolRow(view, pool);
          const used = row.settledMicroUsd + row.reservedMicroUsd;
          const label = t(POOL_LABEL[pool]);
          return (
            <li key={pool} className="tm-ais-row">
              <div className="tm-ais-row__body">
                <p className="tm-ais-row__name">
                  {label}
                  {overCap(row) ? (
                    <StateCapsule state="blocked">{t('AiSpend.caps.overCap')}</StateCapsule>
                  ) : null}
                </p>
                <div
                  className="tm-aic-meter"
                  data-tone={creditsTone(used, row.capMicroUsd)}
                  role="meter"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(row.capMicroUsd, 1)}
                  aria-valuenow={Math.min(used, Math.max(row.capMicroUsd, 1))}
                  aria-valuetext={t('AiSpend.caps.line', {
                    spent: usd(row.settledMicroUsd, locale),
                    held: usd(row.reservedMicroUsd, locale),
                    left: usd(Math.max(row.remainingMicroUsd, 0), locale),
                    cap: usd(row.capMicroUsd, locale),
                  })}
                >
                  <span
                    style={{ inlineSize: `${Math.min(percent(used, row.capMicroUsd), 100)}%` }}
                  />
                </div>
                <p className="tm-ais-muted">
                  {t('AiSpend.caps.line', {
                    spent: usd(row.settledMicroUsd, locale),
                    held: usd(row.reservedMicroUsd, locale),
                    left: usd(Math.max(row.remainingMicroUsd, 0), locale),
                    cap: usd(row.capMicroUsd, locale),
                  })}
                </p>
              </div>
              <Button
                type="button"
                tone="outline"
                aria-label={t('AiSpend.caps.changeFor', { pool: label })}
                onClick={() => onChange(pool)}
              >
                {t('AiSpend.caps.change')}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="tm-ais-muted">
        {t('AiSpend.caps.footnote', { ceiling: usd(view.ceilingMicroUsd, locale) })}
      </p>
    </section>
  );
}

function ControlsCard({
  view,
  onSonnet,
  onPause,
  onRelease,
}: {
  readonly view: AiBudgetView;
  readonly onSonnet: () => void;
  readonly onPause: () => void;
  readonly onRelease: () => void;
}) {
  const { t, locale } = useAiText();
  const free = poolRow(view, 'reserve').remainingMicroUsd;
  return (
    <section className="tm-ais-card" aria-labelledby="ais-controls">
      <header className="tm-ais-card__head">
        <h2 id="ais-controls" className="tm-ais-card__title">
          {t('AiSpend.controls.title')}
        </h2>
      </header>
      <ul className="tm-ais-rows">
        <li className="tm-ais-row">
          <div className="tm-ais-row__body">
            {/* The switch never flips on its own: the reason dialog decides (it shows the server's value). */}
            <Switch
              label={t('AiSpend.controls.sonnet')}
              hint={t(
                view.sonnetEnabled ? 'AiSpend.controls.sonnetOn' : 'AiSpend.controls.sonnetOff',
              )}
              checked={view.sonnetEnabled}
              onChange={(event) => {
                event.preventDefault();
                onSonnet();
              }}
            />
          </div>
        </li>
        <li className="tm-ais-row">
          <div className="tm-ais-row__body">
            <p className="tm-ais-row__name">
              {t(view.paused ? 'AiSpend.controls.resume' : 'AiSpend.controls.pause')}
            </p>
            <p className="tm-ais-muted">
              {t(view.paused ? 'AiSpend.controls.resumeNote' : 'AiSpend.controls.pauseNote')}
            </p>
          </div>
          <Button type="button" tone="outline" onClick={onPause}>
            {t(view.paused ? 'AiSpend.controls.resumeButton' : 'AiSpend.controls.pauseButton')}
          </Button>
        </li>
        <li className="tm-ais-row">
          <div className="tm-ais-row__body">
            <p className="tm-ais-row__name">{t('AiSpend.controls.release')}</p>
            <p className="tm-ais-muted">
              {t('AiSpend.controls.releaseNote', { amount: usd(Math.max(free, 0), locale) })}
            </p>
          </div>
          <Button type="button" tone="outline" disabled={free <= 0} onClick={onRelease}>
            {t('AiSpend.controls.releaseButton')}
          </Button>
        </li>
      </ul>
    </section>
  );
}

function TestListCard({
  query,
  onAdd,
  onOptions,
}: {
  readonly query: ReturnType<typeof useQuery<AiTestListView>>;
  readonly onAdd: () => void;
  readonly onOptions: (entry: AiTestListEntryView) => void;
}) {
  const { t } = useAiText();
  const tt = useT();
  return (
    <section className="tm-ais-card" aria-labelledby="ais-test-list">
      <header className="tm-ais-card__head">
        <h2 id="ais-test-list" className="tm-ais-card__title">
          {t('AiSpend.test.title')}
        </h2>
        <Button type="button" tone="outline" onClick={onAdd}>
          {t('AiSpend.test.add')}
        </Button>
      </header>
      {query.isPending ? <Skeleton height="var(--s24)" /> : null}
      {query.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(query.error, tt)}
        </InlineAlert>
      ) : null}
      {query.isSuccess && query.data.workspaces.length === 0 ? (
        <p className="tm-ais-muted">{t('AiSpend.test.empty')}</p>
      ) : null}
      {query.isSuccess && query.data.workspaces.length > 0 ? (
        <ul className="tm-ais-rows">
          {query.data.workspaces.map((entry) => (
            <li key={entry.organizationId} className="tm-ais-row">
              <p className="tm-ais-row__name">
                {entry.name}
                <span className="tm-ais-chip">
                  {t(
                    entry.poolClass === 'customers'
                      ? 'AiSpend.pool.customers'
                      : 'AiSpend.pool.testing',
                  )}
                </span>
              </p>
              <Button
                type="button"
                tone="text"
                className="tm-ais-more"
                aria-label={t('AiSpend.test.options', { name: entry.name })}
                onClick={() => onOptions(entry)}
              >
                <span aria-hidden="true">•••</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PackRequestsCard({
  list,
  nameOf,
  onGrant,
  onDecline,
}: {
  readonly list: AiTestListView | null;
  readonly nameOf: (organizationId: string) => string;
  readonly onGrant: (request: AiPackRequestQueueView) => void;
  readonly onDecline: (request: AiPackRequestQueueView) => void;
}) {
  const { t, day } = useAiText();
  return (
    <section className="tm-ais-card" aria-labelledby="ais-requests">
      <header className="tm-ais-card__head">
        <h2 id="ais-requests" className="tm-ais-card__title">
          {t('AiSpend.requests.title')}
        </h2>
      </header>
      {list !== null && list.openRequests.length === 0 ? (
        <p className="tm-ais-muted">{t('AiSpend.requests.empty')}</p>
      ) : null}
      {list !== null && list.openRequests.length > 0 ? (
        <ul className="tm-ais-rows">
          {list.openRequests.map((request) => {
            const name = nameOf(request.organizationId);
            return (
              <li key={request.id} className="tm-ais-row">
                <div className="tm-ais-row__body">
                  <p className="tm-ais-row__name">{name}</p>
                  <p className="tm-ais-muted">
                    {t('AiSpend.requests.asked', { date: day(request.requestedAt) })}
                  </p>
                </div>
                <Button
                  type="button"
                  tone="text"
                  aria-label={t('AiSpend.requests.declineFor', { name })}
                  onClick={() => onDecline(request)}
                >
                  {t('AiSpend.requests.decline')}
                </Button>
                <Button
                  type="button"
                  tone="outline"
                  aria-label={t('AiSpend.requests.grantFor', { name })}
                  onClick={() => onGrant(request)}
                >
                  {t('AiSpend.requests.grant')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
