'use client';

import type { MoneyModel } from './overview-model';
import { useOverviewCopy, type OverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import { OverviewCard, OverviewEmpty, OverviewFigures, type OverviewFigure } from './OverviewCard';

/**
 * ONEPAGE Money (Figma 739:40815): invoiced, paid and overdue in one currency (client), or
 * invoiced and not invoiced yet (project). The whole block exists only for finance access.
 */
export function MoneyBlock({
  model,
  format,
}: {
  readonly model: MoneyModel;
  readonly format: OverviewFormat;
}) {
  const copy = useOverviewCopy();
  const { currency } = model;
  return (
    <OverviewCard
      block="money"
      title={copy.text('Overview.money')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {currency === null ? (
        <OverviewEmpty>{copy.text('Overview.moneyEmpty')}</OverviewEmpty>
      ) : (
        <>
          <OverviewFigures figures={moneyFigures(model, currency, format, copy.fill)} />
          {model.moreCurrencies > 0 ? (
            <p className="tm-ov-card__note">
              {copy.count(
                'Overview.moreCurrenciesOne',
                'Overview.moreCurrenciesMany',
                model.moreCurrencies,
                format.count(model.moreCurrencies),
              )}
            </p>
          ) : null}
        </>
      )}
    </OverviewCard>
  );
}

function moneyFigures(
  model: MoneyModel,
  currency: string,
  format: OverviewFormat,
  fill: OverviewCopy['fill'],
): OverviewFigure[] {
  const figures: OverviewFigure[] = [
    { label: fill('Overview.invoiced', { currency }), value: format.amount(model.invoicedMinor) },
  ];
  if (model.paidMinor !== undefined) {
    figures.push({
      label: fill('Overview.paid', { currency }),
      value: format.amount(model.paidMinor),
    });
  }
  if (model.overdueMinor !== undefined) {
    figures.push({
      label: fill('Overview.overdue', { currency }),
      value: format.amount(model.overdueMinor),
      ...(model.overdueMinor > 0 ? { tone: 'danger' as const } : {}),
    });
  }
  if (model.unbilledMinor !== undefined) {
    figures.push({
      label: fill('Overview.unbilled', { currency }),
      value: format.amount(model.unbilledMinor),
    });
  }
  return figures;
}
