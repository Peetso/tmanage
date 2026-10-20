'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSubscription, requestPlanChange } from '../../lib/api/subscription';
import type { SubscriptionView } from '../../lib/api/subscription';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface SubscriptionScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Subscription** — the billing screen `38-…` §Billing asks for: view the current plan and request
 * a plan change. x177 ships the read (`GET …/billing/subscription`) and the change request
 * (`POST …/billing/subscription/change`), both behind `org.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **No rail item.** Like the storage-usage screen, billing is not one of `22-SCREEN-BY-SCREEN`
 *    §1's eight rail destinations, so none is invented; the screen has its own route.
 * 2. **Authorization is the API's.** Both routes sit behind `org.manage`; a member without it gets
 *    the ordinary 403, which `describe()` turns into the forbidden line, never a blank page.
 * 3. **No charge here.** A change is *requested*, not paid. The screen says so, and the returned
 *    status is `pending_change` until a later payment slice (an external provider) activates it.
 */

/** The plan ids a change may target. Kept in step with the API plan catalog (x157 pricing, later). */
const PLAN_IDS: readonly string[] = ['free', 'starter', 'pro', 'business'];

export function SubscriptionScreen({
  organizationSlug,
  organizationName,
  client,
}: SubscriptionScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const subscriptionKey = ['organization-subscription', organizationSlug];

  const subscription = useQuery({
    queryKey: subscriptionKey,
    queryFn: () => fetchSubscription(api, organizationSlug),
  });

  const change = useMutation({
    mutationFn: (planId: string) => requestPlanChange(api, organizationSlug, planId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subscriptionKey });
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('SubscriptionScreen.eyebrow')}
      title={t('SubscriptionScreen.title')}
      description={t('SubscriptionScreen.description')}
    >
      <div className="tm-bil">
        {subscription.isPending ? (
          <LoadingRegion
            label={t('SubscriptionScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {subscription.isError ? (
          <InlineAlert tone="danger" title={t('SubscriptionScreen.loadError')} live>
            {describe(subscription.error)}
          </InlineAlert>
        ) : null}

        {subscription.isSuccess ? (
          <SubscriptionPanel
            subscription={subscription.data}
            onChange={(planId) => change.mutate(planId)}
            isChanging={change.isPending}
            changeError={change.isError ? describe(change.error) : null}
            changed={change.isSuccess ? change.data : null}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function SubscriptionPanel({
  subscription,
  onChange,
  isChanging,
  changeError,
  changed,
}: {
  subscription: SubscriptionView;
  onChange: (planId: string) => void;
  isChanging: boolean;
  changeError: string | null;
  changed: SubscriptionView | null;
}) {
  const t = useT();
  const [target, setTarget] = useState<string>(subscription.planId);

  return (
    <>
      <div className="tm-bil-col tm-bil-col--wide tm-bil-main">
        <div className="tm-bil-figure">
          <p className="tm-bil-eyebrow">
            {subscription.status === 'pending_change'
              ? t('SubscriptionScreen.changePending')
              : t('SubscriptionScreen.active')}
            {subscription.currentPeriodEnd === null
              ? ''
              : ` · ${t('SubscriptionScreen.renewsWord')} ${formatMoment(subscription.currentPeriodEnd)}`}
          </p>
          <p className="tm-bil-figure__value">
            {planLabel(subscription.planId, t)} {t('SubscriptionScreen.planWord')}
          </p>
        </div>

        <section className="tm-bil-card" aria-labelledby="tm-subscription-heading">
          <h2 id="tm-subscription-heading" className="tm-bil-card__title">
            {t('SubscriptionScreen.currentPlanHeading')}
          </h2>

          <dl className="tm-detail-list">
            <div className="tm-detail-list__pair">
              <dt>{t('SubscriptionScreen.planLabelDt')}</dt>
              <dd className="tm-mono">{planLabel(subscription.planId, t)}</dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>{t('SubscriptionScreen.statusLabel')}</dt>
              <dd>
                <StateCapsule
                  state={subscription.status === 'pending_change' ? 'waiting' : 'current'}
                >
                  {subscription.status === 'pending_change'
                    ? t('SubscriptionScreen.changePending')
                    : t('SubscriptionScreen.active')}
                </StateCapsule>
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>{t('SubscriptionScreen.renewsLabelDt')}</dt>
              <dd className="tm-mono">
                {subscription.currentPeriodEnd === null
                  ? t('SubscriptionScreen.noRenewalDate')
                  : formatMoment(subscription.currentPeriodEnd)}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="tm-bil-card" aria-labelledby="tm-subscription-change-heading">
        <h2 id="tm-subscription-change-heading" className="tm-bil-card__title">
          {t('SubscriptionScreen.changePlanHeading')}
        </h2>
        <form
          className="tm-stack tm-stack--tight"
          onSubmit={(event) => {
            event.preventDefault();
            onChange(target);
          }}
        >
          <Select
            label={t('SubscriptionScreen.changePlanLabel')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            hint={t('SubscriptionScreen.changeHint')}
          >
            {PLAN_IDS.map((planId) => (
              <option key={planId} value={planId}>
                {planLabel(planId, t)}
              </option>
            ))}
          </Select>

          <div>
            <Button type="submit" disabled={isChanging}>
              {isChanging
                ? t('SubscriptionScreen.requesting')
                : t('SubscriptionScreen.requestChange')}
            </Button>
          </div>
        </form>

        {changeError !== null ? (
          <InlineAlert tone="danger" title={t('SubscriptionScreen.changeErrorTitle')} live>
            {changeError}
          </InlineAlert>
        ) : null}

        {changed !== null ? (
          <InlineAlert tone="success" title={t('SubscriptionScreen.changeRequestedTitle')} live>
            {`${t('SubscriptionScreen.changedBodyBefore')}${planLabel(changed.planId, t)}${t('SubscriptionScreen.changedBodyAfter')}`}
          </InlineAlert>
        ) : null}
      </section>
    </>
  );
}

function planLabel(planId: string, t: (key: MessageKey) => string): string {
  const labels: Record<string, string> = {
    free: t('SubscriptionScreen.planFree'),
    starter: t('SubscriptionScreen.planStarter'),
    pro: t('SubscriptionScreen.planPro'),
    business: t('SubscriptionScreen.planBusiness'),
  };
  return labels[planId] ?? planId;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
