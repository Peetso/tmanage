'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { PlanChangeDialog } from '../billing/PlanChangeDialog';
import { BetaBillingPanel, useBetaBillingHeading } from '../billing/BetaBillingPanel';
import { dayMonth, fill, gb, money, planName, planUsageText } from '../billing/plan-usage-format';
import type { PlanUsageText } from '../billing/plan-usage-format';
import { browserApiClient } from '../../lib/api/browser-client';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { fetchPlanUsage } from '../../lib/api/plan-usage';
import type { PlanUsageMeterView, PlanUsageView } from '../../lib/api/plan-usage';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/plan-usage.css';

export interface PlanUsageScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The listed plans in ladder order; "Change plan" previews the next one up, else one down. */
const LADDER = ['free', 'starter', 'studio', 'business'] as const;

/**
 * **Plan and usage** — the billing home, Figma F4 (section 390:22381): the current flat plan, the
 * usage meters against its limits (amber near the limit, red over it), and the change preview.
 * Reads `GET …/billing/plan-usage` (`org.manage`); a refusal becomes the API's sentence, never a
 * blank page. Reached from the Control Center, so the Control orb is the one marked current.
 */
export function PlanUsageScreen({
  organizationSlug,
  organizationName,
  client,
}: PlanUsageScreenProps) {
  const tr = planUsageText(useTOr());
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const params = useSearchParams();
  const [changeTarget, setChangeTarget] = useState<string | null>(() => {
    const asked = params?.get('change');
    return asked && (LADDER as readonly string[]).includes(asked) ? asked : null;
  });
  const [requested, setRequested] = useState(false);

  const usage = useQuery({
    queryKey: ['plan-usage', organizationSlug],
    queryFn: () => fetchPlanUsage(api, organizationSlug),
  });
  // The public beta (BILLING_MODE=beta_free, the API's default): free for everyone, nothing to buy.
  const beta = usage.data?.billingMode !== 'paid';
  const betaHeading = useBetaBillingHeading(organizationName);

  const closeDialog = useCallback(
    (didRequest: boolean) => {
      setChangeTarget(null);
      if (didRequest) {
        setRequested(true);
        void queries.invalidateQueries({ queryKey: ['plan-usage', organizationSlug] });
      }
    },
    [queries, organizationSlug],
  );

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      title={beta ? betaHeading.title : tr('PlanUsage.title')}
      description={beta ? betaHeading.description : tr('PlanUsage.lede')}
    >
      <div className="tm-pu">
        {usage.isPending ? (
          <LoadingRegion label={tr('PlanUsage.loading')} className="tm-stack tm-stack--tight">
            <Skeleton height="100px" />
            <Skeleton height="240px" />
          </LoadingRegion>
        ) : null}

        {usage.isError ? (
          <InlineAlert tone="danger" live>
            {usage.error instanceof ApiRequestError
              ? usage.error.message
              : tr('PlanUsage.loadError')}
          </InlineAlert>
        ) : null}

        {requested ? (
          <InlineAlert tone="success" live>
            {tr('PlanUsage.requested')}
          </InlineAlert>
        ) : null}

        {usage.isSuccess && beta ? (
          <BetaBillingPanel internalPeople={usage.data.people.used} />
        ) : null}

        {usage.isSuccess && !beta ? (
          <PlanUsageBody
            view={usage.data}
            locale={locale}
            tr={tr}
            organizationSlug={organizationSlug}
            onChangePlan={() => setChangeTarget(changeTargetFor(usage.data))}
          />
        ) : null}
      </div>

      {changeTarget !== null && usage.isSuccess && !beta ? (
        <PlanChangeDialog
          organizationSlug={organizationSlug}
          targetPlanId={changeTarget}
          client={api}
          onClose={closeDialog}
        />
      ) : null}
    </SettingsShell>
  );
}

function changeTargetFor(view: PlanUsageView): string {
  const index = (LADDER as readonly string[]).indexOf(view.planId);
  if (view.nextPlanId !== null && (LADDER as readonly string[]).includes(view.nextPlanId)) {
    return view.nextPlanId;
  }
  return LADDER[Math.max(0, index - 1)] ?? 'starter';
}

function PlanUsageBody({
  view,
  locale,
  tr,
  organizationSlug,
  onChangePlan,
}: {
  view: PlanUsageView;
  locale: string;
  tr: PlanUsageText;
  organizationSlug: string;
  onChangePlan: () => void;
}) {
  const plan = planName(view.planId);
  const next = view.nextPlanId === null ? null : planName(view.nextPlanId);
  const price = view.monthlyCents === null ? null : money(view.monthlyCents, view.currency);
  const renews = view.renewsOn === null ? null : dayMonth(view.renewsOn, locale);

  const priceLine =
    view.monthlyCents === null
      ? tr('PlanUsage.priceCustom')
      : view.monthlyCents === 0 || renews === null
        ? tr('PlanUsage.priceFree')
        : fill(tr('PlanUsage.priceLine'), { price: price ?? '', date: renews });

  return (
    <>
      {view.level === 'near' ? (
        <InlineAlert tone="warning">{nearAlert(view, plan, next, tr)}</InlineAlert>
      ) : null}
      {view.level === 'over' ? (
        <InlineAlert tone="danger">
          {fill(tr('PlanUsage.alertOver'), {
            plan,
            date: view.graceEndsOn === null ? '' : dayMonth(view.graceEndsOn, locale),
          })}
        </InlineAlert>
      ) : null}

      <section className="tm-pu-card tm-pu-plan" aria-labelledby="tm-pu-plan-name">
        <div className="tm-pu-plan__info">
          <div className="tm-pu-plan__name-row">
            <h2 id="tm-pu-plan-name" className="tm-pu-plan__name">
              {plan}
            </h2>
            <Badge mono>{tr('PlanUsage.currentPlan')}</Badge>
            {view.pendingChange ? <Badge>{tr('PlanUsage.changePending')}</Badge> : null}
          </div>
          <p className="tm-pu-plan__price">{priceLine}</p>
        </div>
        <div className="tm-pu-plan__actions">
          <Link
            href={`/${organizationSlug}/billing/subscription`}
            className="tm-button tm-button--outline tm-button--default"
          >
            {tr('PlanUsage.seeAllPlans')}
          </Link>
          <Button type="button" tone="ink" onClick={onChangePlan}>
            {tr('PlanUsage.changePlan')}
          </Button>
        </div>
      </section>

      <section className="tm-pu-card tm-pu-usage" aria-labelledby="tm-pu-usage-heading">
        <div className="tm-pu-usage__head">
          <h2 id="tm-pu-usage-heading" className="tm-pu-usage__title">
            {tr('PlanUsage.usageHeading')}
          </h2>
          <p className="tm-pu-usage__updated">{updatedText(view.measuredAt, locale, tr)}</p>
        </div>
        <div className="tm-pu-grid">
          {view.people.limit === null ? (
            <BadgeRow
              label={tr('PlanUsage.people')}
              badge={tr('PlanUsage.noLimit')}
              count={fill(tr('PlanUsage.peopleCount'), { count: view.people.used })}
              note={tr('PlanUsage.peopleUnlimited')}
            />
          ) : (
            <Meter
              id="people"
              label={tr('PlanUsage.people')}
              meter={view.people}
              value={fill(tr('PlanUsage.valueOf'), {
                used: view.people.used,
                limit: view.people.limit,
              })}
              note={peopleNote(view.people, plan, next, tr)}
            />
          )}
          {view.projects.limit === null ? (
            <BadgeRow
              label={tr('PlanUsage.projects')}
              badge={tr('PlanUsage.noLimit')}
              count={fill(tr('PlanUsage.activeCount'), { count: view.projects.used })}
              note={tr('PlanUsage.projectsNote')}
            />
          ) : (
            <Meter
              id="projects"
              label={tr('PlanUsage.projects')}
              meter={view.projects}
              value={fill(tr('PlanUsage.valueOf'), {
                used: view.projects.used,
                limit: view.projects.limit,
              })}
              note={projectsNote(view.projects, plan, tr)}
            />
          )}
          <Meter
            id="storage"
            label={tr('PlanUsage.storage')}
            meter={view.storage}
            value={fill(tr('PlanUsage.storageOf'), {
              used: gb(view.storage.used),
              limit: gb(view.storage.limit ?? 0),
            })}
            note={storageNote(view.storage, tr)}
          />
          <BadgeRow
            label={tr('PlanUsage.clients')}
            badge={tr('PlanUsage.included')}
            count={String(view.clients)}
            note={tr('PlanUsage.clientsNote')}
          />
        </div>
      </section>

      <p className="tm-pu-foot">
        {price !== null && renews !== null && view.monthlyCents !== 0
          ? fill(tr('PlanUsage.nextBill'), { price, date: renews })
          : tr('PlanUsage.noBill')}
      </p>
    </>
  );
}

function Meter({
  id,
  label,
  meter,
  value,
  note,
}: {
  id: string;
  label: string;
  meter: PlanUsageMeterView;
  value: string;
  note: string;
}) {
  const limit = meter.limit ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((meter.used / limit) * 100)) : 0;
  const labelId = `tm-pu-meter-${id}`;
  return (
    <div className="tm-pu-meter" data-level={meter.level}>
      <div className="tm-pu-meter__row">
        <span id={labelId} className="tm-pu-meter__label">
          {label}
        </span>
        <span className="tm-pu-meter__value">{value}</span>
      </div>
      <div
        className="tm-pu-meter__track"
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(meter.used, limit)}
        aria-valuetext={value}
      >
        <div className="tm-pu-meter__fill" style={{ inlineSize: `${percent}%` }} />
      </div>
      <p className="tm-pu-meter__note">{note}</p>
    </div>
  );
}

function BadgeRow({
  label,
  badge,
  count,
  note,
}: {
  label: string;
  badge: string;
  count: string;
  note: string;
}) {
  return (
    <div className="tm-pu-meter tm-pu-meter--badge">
      <div className="tm-pu-meter__row">
        <span className="tm-pu-meter__label">{label}</span>
        <span className="tm-pu-meter__count">
          <Badge>{badge}</Badge>
          <span>{count}</span>
        </span>
      </div>
      <p className="tm-pu-meter__note">{note}</p>
    </div>
  );
}

function nearAlert(view: PlanUsageView, plan: string, next: string | null, tr: PlanUsageText) {
  if (next === null) return fill(tr('PlanUsage.alertNearTop'), { plan });
  const storage = `${gb(view.nextPlanStorageBytes ?? 0)} GB`;
  return view.nextPlanPeopleLimit === null
    ? fill(tr('PlanUsage.alertNearUnlimited'), { plan, next, storage })
    : fill(tr('PlanUsage.alertNearLimited'), {
        plan,
        next,
        storage,
        people: view.nextPlanPeopleLimit,
      });
}

function peopleNote(
  meter: PlanUsageMeterView,
  plan: string,
  next: string | null,
  tr: PlanUsageText,
): string {
  const limit = meter.limit ?? 0;
  const left = limit - meter.used;
  if (meter.level === 'over') return fill(tr('PlanUsage.peopleOver'), { over: -left });
  if (left <= 0) {
    return next === null
      ? fill(tr('PlanUsage.peopleFullTop'), { plan })
      : fill(tr('PlanUsage.peopleFull'), { next });
  }
  if (meter.level === 'near' && next !== null) {
    return fill(tr(left === 1 ? 'PlanUsage.peopleNearOne' : 'PlanUsage.peopleNear'), {
      left,
      next,
    });
  }
  return fill(tr(left === 1 ? 'PlanUsage.peopleNormalOne' : 'PlanUsage.peopleNormal'), {
    left,
    plan,
  });
}

function projectsNote(meter: PlanUsageMeterView, plan: string, tr: PlanUsageText): string {
  const left = (meter.limit ?? 0) - meter.used;
  if (meter.level === 'over') return fill(tr('PlanUsage.projectsOver'), { over: -left });
  return meter.level === 'near'
    ? fill(tr('PlanUsage.projectsNear'), { left: Math.max(0, left) })
    : fill(tr('PlanUsage.projectsNormal'), { left, plan });
}

function storageNote(meter: PlanUsageMeterView, tr: PlanUsageText): string {
  const limit = meter.limit ?? 0;
  if (meter.level === 'over') {
    return fill(tr('PlanUsage.storageOver'), { over: gb(meter.used - limit) });
  }
  const free = gb(limit - meter.used);
  return meter.level === 'near'
    ? fill(tr('PlanUsage.storageNear'), { free, limit: gb(limit) })
    : fill(tr('PlanUsage.storageNormal'), { free });
}

function updatedText(measuredAt: string, locale: string, tr: PlanUsageText): string {
  const at = new Date(measuredAt);
  const minutes = (Date.now() - at.getTime()) / 60_000;
  if (Number.isNaN(minutes) || minutes < 1) return tr('PlanUsage.updatedJustNow');
  if (minutes < 60) return tr('PlanUsage.updatedFewMinutes');
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);
  return fill(tr('PlanUsage.updatedAt'), { time });
}
