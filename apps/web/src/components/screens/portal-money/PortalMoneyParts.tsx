'use client';

import { useCallback } from 'react';
import { StateCapsule, Tooltip } from '@tmanage/ui';
import type { BurnStatus, InvoiceStanding } from '@tmanage/domain';
import type { PortalBudget, PortalRetainer } from '../../../lib/api/portal-money';
import { portalInvoicePdfUrl } from '../../../lib/api/portal-money';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { pluralPhrase } from '../../../lib/i18n/plural';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FormatIcon } from '../../viewer/format-icons';
import { shortDay } from '../PortalParts';
import '../../../styles/screens/portal-money.css';

/** The `tOr` the Money screens read every string through (English is the fallback). */
export type MoneyText = (key: string, english: string) => string;

/**
 * "EGP 45,600" — the currency code, then the amount in the active locale's grouping and digits;
 * cents only when there are any. The code leads in Arabic too, as the rest of the product shows
 * amounts. Render it inside `<bdi>` so the run keeps its order in a right-to-left page.
 */
export function useMoney(): (amountMinor: number, currency: string) => string {
  const formatters = useDisplayFormatters();
  return useCallback(
    (amountMinor: number, currency: string) => {
      const whole = amountMinor % 100 === 0;
      const digits = whole ? 0 : 2;
      const amount = formatters.number(amountMinor / 100, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      return `${currency} ${amount}`;
    },
    [formatters],
  );
}

/** A count phrase in the locale's plural form, `{count}` filled. */
export function useCount(): (base: string, count: number, one: string, other: string) => string {
  const tOr = useTOr();
  const locale = useActiveLocale();
  return useCallback(
    (base: string, count: number, one: string, other: string) =>
      pluralPhrase(tOr, locale, base, count, { one, other }),
    [tOr, locale],
  );
}

/**
 * Where an invoice stands, as the API worked it out on the workspace's calendar (52-13): never by
 * colour alone — a shape and a word in every state.
 */
export function StandingCapsule({ standing }: { readonly standing: InvoiceStanding }) {
  const tOr = useTOr();
  const count = useCount();
  switch (standing.kind) {
    case 'paid':
      return <StateCapsule state="done">{tOr('PortalMoney.paid', 'Paid')}</StateCapsule>;
    case 'overdue':
      return (
        <StateCapsule state="blocked" glyph="!">
          {count(
            'PortalMoney.overdueDays',
            standing.days,
            'Overdue · {count} day',
            'Overdue · {count} days',
          )}
        </StateCapsule>
      );
    case 'due':
      return (
        <StateCapsule state="waiting">
          {standing.days === 0
            ? tOr('PortalMoney.dueToday', 'Due today')
            : count(
                'PortalMoney.dueInDays',
                standing.days,
                'Due in {count} day',
                'Due in {count} days',
              )}
        </StateCapsule>
      );
    case 'open':
      return <StateCapsule state="neutral">{tOr('PortalMoney.toPay', 'To pay')}</StateCapsule>;
  }
}

/**
 * "Download PDF": the PDF of the client's own invoice (52-10), a separate target
 * from the row (the row opens the invoice). Its name carries the invoice number; hover or focus
 * shows the help text.
 */
export function DownloadPdfLink({
  organizationSlug,
  invoiceId,
  number,
  variant = 'orb',
}: {
  readonly organizationSlug: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly variant?: 'orb' | 'button';
}) {
  const tOr = useTOr();
  const arabic = useActiveLocale().startsWith('ar');
  const href = portalInvoicePdfUrl(apiBaseUrl(), organizationSlug, invoiceId, arabic ? 'ar' : 'en');
  const help = tOr('PortalMoney.downloadPdf', 'Download PDF');
  if (variant === 'button') {
    return (
      <a
        className="tm-pt-btn tm-pt-btn--ink tm-pm-download"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        <FormatIcon name="download" />
        {help}
      </a>
    );
  }
  const name = number ? `${tOr('PortalMoney.downloadPdfOf', 'Download PDF of')} ${number}` : help;
  return (
    <Tooltip content={help}>
      <a
        className="tm-orb-button tm-orb-button--compact tm-orb-button--outline tm-pm-orb"
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={name}
      >
        <FormatIcon name="download" />
      </a>
    </Tooltip>
  );
}

/** A plain bar: how much of the whole is used, with its name for a screen reader. */
function UsageBar({ percent, label }: { readonly percent: number; readonly label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="tm-pm-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span className="tm-pm-bar__fill" style={{ inlineSize: `${value}%` }} />
    </div>
  );
}

/** "About three quarters of this period's hours are used." — the share in words, to the quarter. */
function shareSentence(used: number, allowance: number, tOr: MoneyText): string {
  const quarter = allowance <= 0 ? 0 : Math.round((used / allowance) * 4);
  if (quarter <= 0)
    return tOr('PortalMoney.shareNone', "Hardly any of this period's hours are used yet.");
  if (quarter === 1)
    return tOr('PortalMoney.shareQuarter', "About a quarter of this period's hours are used.");
  if (quarter === 2)
    return tOr('PortalMoney.shareHalf', "About half of this period's hours are used.");
  if (quarter === 3)
    return tOr(
      'PortalMoney.shareThreeQuarters',
      "About three quarters of this period's hours are used.",
    );
  return tOr('PortalMoney.shareAll', "All of this period's hours are used.");
}

/** The retainer this period: hours used of the allowance, a bar and one sentence. Hours only. */
export function RetainerCard({ retainer }: { readonly retainer: PortalRetainer }) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const { number } = useDisplayFormatters();
  const hours = (value: number) => number(value, { maximumFractionDigits: 1 });
  const percent =
    retainer.allowanceHours > 0 ? (retainer.usedHours / retainer.allowanceHours) * 100 : 0;
  const period = `${shortDay(retainer.periodStart, locale)} – ${shortDay(retainer.periodEnd, locale)}`;
  return (
    <article className="tm-pt-card tm-pm-usage" aria-labelledby={`tm-pm-retainer-${retainer.id}`}>
      <p className="tm-pt-eyebrow">
        {tOr('PortalMoney.retainerEyebrow', 'Your retainer')} · <bdi>{period}</bdi>
      </p>
      <h3 id={`tm-pm-retainer-${retainer.id}`} className="tm-pt-card__title">
        {retainer.name}
      </h3>
      <p className="tm-pm-usage__figure">
        <span className="tm-pm-usage__value">{hours(retainer.usedHours)}</span>{' '}
        {tOr('PortalMoney.hoursUsedOf', 'of {total} hours used').replace(
          '{total}',
          hours(retainer.allowanceHours),
        )}
      </p>
      <UsageBar percent={percent} label={tOr('PortalMoney.retainerUsed', 'Retainer hours used')} />
      <p className="tm-pm-usage__ends">
        <span>
          {tOr('PortalMoney.hoursUsed', '{hours} hours used').replace(
            '{hours}',
            hours(retainer.usedHours),
          )}
        </span>
        <span>
          {tOr('PortalMoney.hoursLeft', '{hours} hours left').replace(
            '{hours}',
            hours(retainer.remainingHours),
          )}
        </span>
      </p>
      <p className="tm-pt-card__body tm-pm-usage__sentence">
        {shareSentence(retainer.usedHours, retainer.allowanceHours, tOr)}
        {retainer.renewsOn
          ? ` ${tOr('PortalMoney.renewsOn', 'Your retainer renews on {date}.').replace('{date}', shortDay(retainer.renewsOn, locale))}`
          : ''}
      </p>
    </article>
  );
}

const BUDGET_STATE: Record<BurnStatus, 'done' | 'waiting' | 'blocked'> = {
  on_track: 'done',
  at_risk: 'waiting',
  over: 'blocked',
};

function budgetSentence(
  budget: PortalBudget,
  tOr: MoneyText,
  hours: (n: number) => string,
): string {
  if (budget.status === 'over')
    return tOr(
      'PortalMoney.budgetOver',
      'The agreed budget is used up. Your project team will talk to you about the next step.',
    );
  if (budget.status === 'at_risk')
    return tOr(
      'PortalMoney.budgetAtRisk',
      'Most of the agreed budget is used. Your project team will talk to you before it runs out.',
    );
  return budget.remainingHours === undefined
    ? tOr('PortalMoney.budgetOnTrack', 'Work is on track.')
    : tOr(
        'PortalMoney.budgetOnTrackHours',
        'Work is on track, with about {hours} hours left in the budget.',
      ).replace('{hours}', hours(budget.remainingHours));
}

/** A shared project's budget: the share used, its status in a shape and a word, one sentence. */
export function BudgetCard({
  projectName,
  budget,
}: {
  readonly projectName: string;
  readonly budget: PortalBudget;
}) {
  const tOr = useTOr();
  const { number } = useDisplayFormatters();
  const hours = (value: number) => number(Math.round(value));
  const status = {
    on_track: tOr('PortalMoney.onTrack', 'On track'),
    at_risk: tOr('PortalMoney.atRisk', 'Close to the limit'),
    over: tOr('PortalMoney.overBudget', 'Over budget'),
  }[budget.status];
  return (
    <article className="tm-pt-card tm-pm-usage" aria-labelledby="tm-pm-budget">
      <p className="tm-pt-eyebrow">{tOr('PortalMoney.budgetEyebrow', 'Project budget')}</p>
      <div className="tm-pt-card__head">
        <h3 id="tm-pm-budget" className="tm-pt-card__title">
          {projectName}
        </h3>
        <StateCapsule state={BUDGET_STATE[budget.status]}>{status}</StateCapsule>
      </div>
      <p className="tm-pm-usage__figure">
        <span className="tm-pm-usage__value">{number(Math.round(budget.percentUsed))}%</span>{' '}
        {tOr('PortalMoney.budgetUsed', 'of the agreed budget used')}
      </p>
      <UsageBar
        percent={budget.percentUsed}
        label={tOr('PortalMoney.budgetUsedLabel', 'Budget used')}
      />
      <p className="tm-pt-card__body tm-pm-usage__sentence">{budgetSentence(budget, tOr, hours)}</p>
    </article>
  );
}

/** A failed read in the client's words. */
export function describeMoneyError(error: unknown, tOr: MoneyText): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError)
    return tOr('PortalMoney.notAnswering', 'The portal is not answering. Try again in a moment.');
  return tOr('PortalMoney.genericError', 'Something went wrong. Try again.');
}

/** A read that answered 404: the thing is not the client's to see (or no longer shared). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}
