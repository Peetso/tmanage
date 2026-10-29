'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  REGION_REQUEST_HREF,
  fetchPublicDataLocation,
  regionLabelOf,
} from '../../lib/api/public-data-location';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { arabicTwinPath } from '../../lib/i18n/public-locale-routes';
import { TransferNotice } from '../website/pages/data-location/TransferNotice';
import '../website/pages/data-location/data-location.css';
import './data-location-card.css';

export interface DataLocationCardProps {
  readonly organizationName: string;
  readonly client: ApiClient;
}

/** The full public statement; its Arabic twin for an Arabic reader. */
const STATEMENT_PATH = '/security/data-location';

/** [key, label, value] — Figma 445:20940. */
const LOCATION_ROWS: readonly (readonly [string, string, string])[] = [
  ['database', 'Database and app', 'Hostinger shared hosting, data centre in Europe'],
  ['files', 'Files', 'Google Drive · in your own region'],
  ['backups', 'Backups', 'Hostinger, same region · offline copies held by the TManage team'],
  ['email', 'Email', 'Hostinger SMTP · Europe'],
  ['ai', 'AI', 'None. You use your own Claude or ChatGPT.'],
];

/** [key, name, purpose, always] — Figma 445:20979. */
const PROCESSORS: readonly (readonly [string, string, string, boolean])[] = [
  ['hostinger', 'Hostinger', 'Hosting, database, email and backups', true],
  ['google', 'Google', 'Drive files, only if you connect it', false],
  ['microsoft', 'Microsoft', 'OneDrive files, only if you connect it', false],
  ['connectors', 'Slack · Meta · Figma · GitHub', 'Only the connectors you turn on', false],
];

/**
 * **Organization → Data location** (54-17; Figma 445:20785 EN, 445:21006 AR).
 *
 * Where this organization's data is stored and processed today — every organization is in the
 * `default` region until 54-18 — with the transfer notice, the request for a different region and
 * the link to the full public statement; beside it, who processes the data. The data-centre label
 * comes from the public data-location read, so the card and the public page always agree.
 */
export function DataLocationCard({ organizationName, client }: DataLocationCardProps) {
  const tr = useTOr();
  const arabic = useActiveLocale().startsWith('ar');
  const statementHref = arabic ? arabicTwinPath(STATEMENT_PATH) : STATEMENT_PATH;
  const location = useQuery({
    queryKey: ['public-data-location'],
    queryFn: () => fetchPublicDataLocation(client),
    staleTime: 5 * 60_000,
  });
  const regionLabel = regionLabelOf(
    location.data,
    tr('DataLocation.regionFallback', 'Europe (Hostinger)'),
  );

  return (
    <div className="tm-dloc-org">
      <section className="tm-dloc-card" aria-labelledby="tm-dloc-card-title">
        <div className="tm-dloc-card__heading">
          <div className="tm-dloc-card__title-row">
            <h2 id="tm-dloc-card-title" className="tm-dloc-card__title">
              {tr('DataLocation.cardTitle', 'Data location')}
            </h2>
            <Badge mono className="tm-dloc-badge">
              {tr('DataLocation.cardDefaultRegion', 'Default region')}
            </Badge>
          </div>
          <p className="tm-dloc-card__lede">
            {tr(
              'DataLocation.cardLede',
              'Where {organization}’s data is stored and processed today.',
            ).replace('{organization}', organizationName)}
          </p>
        </div>

        <dl className="tm-dloc-card__rows">
          <div className="tm-dloc-card__row">
            <dt>{tr('DataLocation.cardRegion', 'Region')}</dt>
            <dd>
              {tr('DataLocation.cardRegionValue', 'Default · {label}').replace(
                '{label}',
                regionLabel,
              )}
            </dd>
          </div>
          {LOCATION_ROWS.map(([key, label, value]) => (
            <div key={key} className="tm-dloc-card__row">
              <dt>{tr(`DataLocation.row.${key}.data`, label)}</dt>
              <dd>{tr(`DataLocation.card.${key}`, value)}</dd>
            </div>
          ))}
        </dl>

        <TransferNotice
          title={tr(
            'DataLocation.transferTitle',
            'Your data is stored outside Saudi Arabia, the UAE and Egypt',
          )}
          body={tr(
            'DataLocation.cardTransferBody',
            'Saudi Arabia: transferred under PDPL Article 29 with SDAIA standard contractual clauses attached. UAE: contractual safeguards. Egypt: public bodies may need a transfer permit.',
          )}
        />

        <div className="tm-dloc-card__actions">
          <Link
            href={REGION_REQUEST_HREF}
            className="tm-button tm-button--ink tm-button--feature tm-dloc-button"
          >
            {tr('DataLocation.requestAction', 'Ask for a different region')}
          </Link>
          <Link
            href={statementHref}
            className="tm-button tm-button--text tm-button--feature tm-dloc-card__statement"
          >
            {tr('DataLocation.readStatement', 'Read the full statement →')}
          </Link>
        </div>
      </section>

      <section className="tm-dloc-card tm-dloc-card--side" aria-labelledby="tm-dloc-who-title">
        <h2 id="tm-dloc-who-title" className="tm-dloc-card__title">
          {tr('DataLocation.whoTitle', 'Who processes your data')}
        </h2>
        <ul className="tm-dloc-card__processors">
          {PROCESSORS.map(([key, name, purpose, always]) => (
            <li key={key} className="tm-dloc-card__processor">
              <span className="tm-dloc-card__processor-text">
                <span className="tm-dloc-card__processor-name">
                  {tr(`DataLocation.who.${key}.name`, name)}
                </span>
                <span className="tm-dloc-card__processor-purpose">
                  {tr(`DataLocation.who.${key}.purpose`, purpose)}
                </span>
              </span>
              {always ? (
                <Badge mono className="tm-dloc-badge">
                  {tr('DataLocation.always', 'Always')}
                </Badge>
              ) : (
                <Badge className="tm-dloc-badge">
                  {tr('DataLocation.yourChoice', 'Your choice')}
                </Badge>
              )}
            </li>
          ))}
        </ul>
        <p className="tm-dloc-card__note">
          {tr(
            'DataLocation.whoNote',
            'We email owners 30 days before a subprocessor is added or changed.',
          )}
        </p>
      </section>
    </div>
  );
}
