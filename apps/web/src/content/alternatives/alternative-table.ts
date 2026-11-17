import {
  COMPARE_FEATURES,
  type CompareCell,
  type CompareFeature,
  type CompareLanguage,
} from '../compare/compare-entries';
import { ALTERNATIVE_COPY, type AlternativeRow } from './alternative-copy';
import type { AlternativePage } from './alternative-entries';

/**
 * SEOF (B1) — the side-by-side table of an alternative page, built from the other product's
 * compare entry: one row per feature that entry confirms (invoices aside: kept to the compare
 * page, where the TManage cell notes there is no online payment yet), the pricing row linking their pricing page instead of naming a price, and a last row
 * with the entry's own "where it is strong" line, marked as the place they are ahead.
 */

/** The other product's cell: a link to its pricing page, a sourced fact, or where it is strong. */
export type AlternativeTheirs =
  | { readonly kind: 'pricing'; readonly href: string; readonly text: string }
  | { readonly kind: 'fact'; readonly cell: CompareCell; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string; readonly ahead: string };

export interface AlternativeTableRow {
  readonly id: AlternativeRow;
  readonly label: string;
  readonly ours: string;
  readonly theirs: AlternativeTheirs;
}

/** The compare features an alternative page shows, in its order. */
const TABLE_FEATURES = COMPARE_FEATURES.filter(
  (feature): feature is Exclude<CompareFeature, 'invoices'> => feature !== 'invoices',
);

export function alternativeTable(
  page: AlternativePage,
  language: CompareLanguage,
): AlternativeTableRow[] {
  const copy = ALTERNATIVE_COPY[language];
  const { rival } = page;
  const facts = TABLE_FEATURES.flatMap((feature): AlternativeTableRow[] => {
    const cell = rival.rows[feature];
    return cell === undefined
      ? []
      : [
          {
            id: feature,
            label: copy.rows[feature],
            ours: copy.ours[feature],
            theirs: { kind: 'fact', cell, text: cell.text[language] },
          },
        ];
  });
  return [
    {
      id: 'pricing',
      label: copy.rows.pricing,
      ours: copy.ours.pricing,
      theirs: { kind: 'pricing', href: rival.pricingUrl, text: copy.seePricing(rival.name) },
    },
    ...facts,
    {
      id: 'strong',
      label: copy.strongRow(rival.name),
      ours: copy.ours.strong,
      theirs: { kind: 'strong', text: rival.strong[language], ahead: copy.ahead(rival.name) },
    },
  ];
}

/** The pages the table's facts were read on, then the pricing page, each once. */
export function alternativeSources(page: AlternativePage): string[] {
  const cells = TABLE_FEATURES.flatMap((feature) => page.rival.rows[feature]?.source ?? []);
  return [...new Set([...cells, page.rival.pricingUrl])];
}

/** How a source is written under the table: `basecamp.com/pricing`. */
export function sourceLabel(url: string): string {
  const { hostname, pathname } = new URL(url);
  return `${hostname.replace(/^www\./, '')}${pathname.replace(/\/$/, '')}`;
}
