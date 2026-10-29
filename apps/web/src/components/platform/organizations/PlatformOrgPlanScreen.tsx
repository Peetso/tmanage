'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  disconnectPlatformOrgStorage,
  fetchPlatformOrgPlan,
  fetchPlatformOrgStorage,
  recountPlatformOrgStorage,
  setPlatformOrgLimits,
  setPlatformOrgPlan,
} from '../../../lib/api/platform-organizations';
import type {
  PlatformOrgDetailView,
  PlatformOrgLimitView,
  PlatformOrgPlanView,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText, ReasonDialog } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { formatGb, ORGS_KEY, orgKey, StorageBar, usePlanLabel, useRelative } from './org-kit';
import { OrgPage } from './OrgPage';

const GB = 1024 ** 3;
type Override = PlatformOrgPlanView['override'];

/** A5 `/platform/organizations/[id]/plan` — plan, billing mode, limits and storage (frame A5). */
export function PlatformOrgPlanScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <OrgPage api={api} organizationId={organizationId} tab="plan" title={t('PlatformOrgs.tabPlan')}>
      {(detail) => <PlanBody api={api} detail={detail} />}
    </OrgPage>
  );
}

function PlanBody({ api, detail }: { api: ApiClient; detail: PlatformOrgDetailView }) {
  const id = detail.organization.id;
  const plan = useQuery({
    queryKey: orgKey(id, 'plan'),
    queryFn: () => fetchPlatformOrgPlan(api, id),
    retry: false,
  });
  return (
    <>
      {plan.isPending ? <PlatformPageState state="loading" /> : null}
      {plan.isError ? (
        <PlatformPageState state="error" error={plan.error} onRetry={() => void plan.refetch()} />
      ) : null}
      {plan.isSuccess ? (
        <div className="tm-cc-split tm-cc-split--even">
          <PlanCard api={api} id={id} view={plan.data} />
          <LimitsCard api={api} id={id} view={plan.data} />
        </div>
      ) : null}
      <StorageCard api={api} id={id} />
    </>
  );
}

function PlanCard({ api, id, view }: { api: ApiClient; id: string; view: PlatformOrgPlanView }) {
  const t = useT();
  const planLabel = usePlanLabel();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [planId, setPlanId] = useState(view.planId);
  const [override, setOverride] = useState<Override>(view.override);
  const [confirming, setConfirming] = useState(false);
  const dirty = planId !== view.planId || override !== view.override;
  const modeLabel = (mode: 'beta_free' | 'paid') =>
    mode === 'beta_free' ? t('PlatformOrgs.modeBetaFree') : t('PlatformOrgs.modePaid');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) setConfirming(true);
  }
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-plan">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-plan" className="tm-cc-card__title">
          {t('PlatformOrgs.planAndBilling')}
        </h2>
        <span className="tm-cc-pill tm-cc-pill--on">{modeLabel(view.effectiveMode)}</span>
      </div>
      <form className="tm-cc-form" onSubmit={submit} noValidate>
        <Select
          label={t('PlatformOrgs.fieldPlan')}
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          disabled={!canEdit}
        >
          {view.plans.map((plan) => (
            <option key={plan} value={plan}>
              {planLabel(plan)}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformOrgs.billingMode')}
          hint={`${t('PlatformOrgs.platformModeIs')} ${modeLabel(view.platformMode)}`}
          value={override}
          onChange={(e) => setOverride(e.target.value as Override)}
          disabled={!canEdit}
        >
          <option value="inherit">{t('PlatformOrgs.modeInherit')}</option>
          <option value="beta_free">{t('PlatformOrgs.modeBetaFree')}</option>
          <option value="paid">{t('PlatformOrgs.modePaid')}</option>
        </Select>
        {view.subscription ? (
          <p className="tm-cc-note">
            {t('PlatformOrgs.subscription')} · {view.subscription.status}
            {view.subscription.currentPeriodEnd
              ? ` · ${view.subscription.currentPeriodEnd.slice(0, 10)}`
              : ''}
          </p>
        ) : null}
        {canEdit ? (
          <div className="tm-cc-card__actions tm-cc-card__actions--end">
            <Button type="submit" tone="ink" disabled={!dirty}>
              {t('PlatformOrgs.changePlan')}
            </Button>
          </div>
        ) : null}
      </form>
      {confirming ? (
        <ReasonDialog
          title={t('PlatformOrgs.changePlan')}
          body={`${planLabel(planId)} · ${override === 'inherit' ? t('PlatformOrgs.modeInherit') : modeLabel(override)}`}
          reasonRequired
          confirmLabel={t('PlatformOrgs.changePlan')}
          onConfirm={(reason) =>
            setPlatformOrgPlan(api, id, {
              ...(planId !== view.planId ? { planId } : {}),
              billingModeOverride: override,
              reason: reason ?? '',
            })
          }
          onClose={(done) => {
            setConfirming(false);
            if (done) void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
          }}
        />
      ) : null}
    </section>
  );
}

function limitText(value: number | null, bytes: boolean): string {
  if (value === null) return '';
  return bytes ? String(Math.round((value / GB) * 10) / 10) : String(value);
}

function parseLimit(text: string, bytes: boolean): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return bytes ? Math.round(value * GB) : Math.round(value);
}

function LimitsCard({ api, id, view }: { api: ApiClient; id: string; view: PlatformOrgPlanView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [people, setPeople] = useState(limitText(view.limits.people.override, false));
  const [projects, setProjects] = useState(limitText(view.limits.activeProjects.override, false));
  const [storage, setStorage] = useState(limitText(view.limits.storageBytes.override, true));
  const save = useMutation({
    mutationFn: () =>
      setPlatformOrgLimits(api, id, {
        people: parseLimit(people, false),
        activeProjects: parseLimit(projects, false),
        storageBytes: parseLimit(storage, true),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORGS_KEY }),
  });
  const planHint = (item: PlatformOrgLimitView, bytes: boolean) =>
    `${t('PlatformOrgs.planLimit')} ${item.plan === null ? '∞' : bytes ? formatGb(item.plan) : item.plan} · ${t('PlatformOrgs.inUse')} ${bytes ? formatGb(item.usage) : item.usage}`;
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-limits">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-limits" className="tm-cc-card__title">
          {t('PlatformOrgs.limits')}
        </h2>
      </div>
      <form
        className="tm-cc-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
        noValidate
      >
        <p className="tm-cc-note">{t('PlatformOrgs.limitsHint')}</p>
        <Field
          label={t('PlatformOrgs.limitPeople')}
          hint={planHint(view.limits.people, false)}
          type="number"
          min={0}
          value={people}
          onChange={(e) => setPeople(e.target.value)}
          disabled={!canEdit}
        />
        <Field
          label={t('PlatformOrgs.limitProjects')}
          hint={planHint(view.limits.activeProjects, false)}
          type="number"
          min={0}
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
          disabled={!canEdit}
        />
        <Field
          label={`${t('PlatformOrgs.limitStorage')} (${t('PlatformOrgs.gb')})`}
          hint={planHint(view.limits.storageBytes, true)}
          type="number"
          min={0}
          step="0.1"
          value={storage}
          onChange={(e) => setStorage(e.target.value)}
          disabled={!canEdit}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        {canEdit ? (
          <div className="tm-cc-card__actions tm-cc-card__actions--end">
            <Button
              type="submit"
              tone="outline"
              loading={save.isPending}
              loadingLabel={t('PlatformShared.working')}
            >
              {t('PlatformOrgs.saveLimits')}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function StorageCard({ api, id }: { api: ApiClient; id: string }) {
  const t = useT();
  const relative = useRelative();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const storage = useQuery({
    queryKey: orgKey(id, 'storage'),
    queryFn: () => fetchPlatformOrgStorage(api, id),
    retry: false,
  });
  const recount = useMutation({
    mutationFn: () => recountPlatformOrgStorage(api, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORGS_KEY }),
  });
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-storage">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-storage" className="tm-cc-card__title">
          {t('PlatformOrgs.tileStorage')}
        </h2>
        {canEdit ? (
          <Button
            type="button"
            tone="outline"
            size="compact"
            loading={recount.isPending}
            loadingLabel={t('PlatformShared.working')}
            onClick={() => recount.mutate()}
          >
            {t('PlatformOrgs.recount')}
          </Button>
        ) : null}
      </div>
      {storage.isPending ? <PlatformPageState state="loading" /> : null}
      {storage.isError ? (
        <PlatformPageState
          state="error"
          error={storage.error}
          onRetry={() => void storage.refetch()}
        />
      ) : null}
      {storage.isSuccess ? (
        <>
          <StorageBar used={storage.data.usedBytes} limit={storage.data.limitBytes} />
          {storage.data.connections.length === 0 ? (
            <p className="tm-cc-note">{t('PlatformOrgs.noConnections')}</p>
          ) : (
            <ul className="tm-cc-rows">
              {storage.data.connections.map((connection) => (
                <li key={connection.id} className="tm-cc-rows__grow tm-cc-hero__actions">
                  <span className="tm-cc-rows__title">{connection.provider}</span>
                  <span className="tm-cc-cell-mono">{connection.accountEmail ?? '—'}</span>
                  <span className="tm-chip">{connection.status}</span>
                  <span className="tm-cc-note">{relative(connection.lastSyncAt)}</span>
                  {canEdit && connection.status !== 'disconnected' ? (
                    <Button
                      type="button"
                      tone="destructive"
                      size="compact"
                      onClick={() => setDisconnecting(connection.id)}
                    >
                      {t('PlatformOrgs.disconnect')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {recount.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(recount.error, t)}
        </InlineAlert>
      ) : null}
      {disconnecting ? (
        <ReasonDialog
          title={t('PlatformOrgs.disconnect')}
          body={t('PlatformOrgs.disconnectBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformOrgs.disconnect')}
          onConfirm={(reason) => disconnectPlatformOrgStorage(api, id, disconnecting, reason ?? '')}
          onClose={(done) => {
            setDisconnecting(null);
            if (done) void queryClient.invalidateQueries({ queryKey: orgKey(id, 'storage') });
          }}
        />
      ) : null}
    </section>
  );
}
