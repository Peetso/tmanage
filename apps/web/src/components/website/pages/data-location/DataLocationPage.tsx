'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@tmanage/ui';
import { ButtonLink } from '../../primitives';
import { browserApiClient } from '../../../../lib/api/browser-client';
import type { ApiClient } from '../../../../lib/api/client';
import {
  REGION_REQUEST_HREF,
  fetchPublicDataLocation,
  regionLabelOf,
} from '../../../../lib/api/public-data-location';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { TransferNotice } from './TransferNotice';
import './data-location.css';

/** Where a reviewer asks to be told about subprocessor changes. */
const CHANGE_NOTICES_HREF = '/contact?topic=subprocessor_notices#book-demo-form';

type Row = readonly [key: string, data: string, where: string, who: string];

/** "What lives where" — Figma 443:21565. [key, data, where it lives, who processes it]. */
const LOCATION_ROWS: readonly Row[] = [
  [
    'database',
    'Database and app',
    'Hostinger shared hosting · data centre in Europe',
    'Hostinger (hosting)',
  ],
  [
    'files',
    'Files',
    'Your own Google Drive or OneDrive (in your region), or TManage storage in the same data centre',
    'Google or Microsoft, your choice · Hostinger',
  ],
  [
    'backups',
    'Backups',
    'Hostinger, same region · offline copies held by the TManage team',
    'Hostinger · TManage',
  ],
  ['email', 'Email', 'Hostinger SMTP · Europe', 'Hostinger (email)'],
  ['logs', 'Logs', 'On the same server as the app', 'Hostinger'],
  [
    'ai',
    'AI',
    'None. TManage calls no AI model. You connect your own Claude or ChatGPT.',
    'You and your AI provider',
  ],
  [
    'connectors',
    'Connectors',
    'Only the vendors you connect: Slack, Meta (WhatsApp), Figma, GitHub, Microsoft, Google',
    'Each one is your choice',
  ],
];

/** The subprocessor list — Figma 443:21612. [key, name, what it does, where]. */
const SUBPROCESSOR_ROWS: readonly Row[] = [
  ['hostinger', 'Hostinger International', 'Hosting, database, email and backups', 'Europe'],
  ['google', 'Google', 'Drive files, only if you connect it', 'Your Google account’s region'],
  [
    'microsoft',
    'Microsoft',
    'OneDrive and Teams, only if you connect them',
    'Your Microsoft account’s region',
  ],
  [
    'connectors',
    'Slack · Meta · Figma · GitHub',
    'Only the connectors you turn on',
    'Each vendor’s region',
  ],
];

/**
 * **Where your data lives** (`/security/data-location`, 54-17; Figma 443:21293 EN, 443:21645 AR).
 *
 * The honest residency statement a buyer's IT or legal reviewer reads first: what lives where and
 * who processes it, the cross-border transfer notice (KSA PDPL Art. 29 / UAE / Egypt, §14.2), the
 * subprocessor list with its 30-day change notice, and the way to ask for a different region. The
 * region badge names the deployment's data-centre label from the public read; until it answers the
 * catalog's stand-in is shown, so the prerendered page is complete.
 */
export function DataLocationPage({ client }: { client?: ApiClient }) {
  const tr = useTOr();
  const api = client ?? browserApiClient();
  const location = useQuery({
    queryKey: ['public-data-location'],
    queryFn: () => fetchPublicDataLocation(api),
    staleTime: 5 * 60_000,
  });
  const regionLabel = regionLabelOf(
    location.data,
    tr('DataLocation.regionFallback', 'Europe (Hostinger)'),
  );

  return (
    <div className="tm-dloc">
      <div className="tm-web-container tm-dloc__content">
        <header className="tm-dloc-hero">
          <p className="tm-dloc-hero__eyebrow">
            {tr('DataLocation.eyebrow', 'Trust · Data location')}
          </p>
          <h1 className="tm-dloc-hero__title">
            {tr('DataLocation.title', 'Where your data lives')}
          </h1>
          <p className="tm-dloc-hero__lede">
            {tr(
              'DataLocation.lede',
              'Exactly where TManage keeps your database, files, backups, email and logs today, and who processes each part.',
            )}
          </p>
          <div className="tm-dloc-hero__meta">
            <Badge className="tm-dloc-badge">
              {tr('DataLocation.lastUpdated', 'Last updated 29 Oct 2026')}
            </Badge>
            <Badge mono className="tm-dloc-badge">
              {tr('DataLocation.regionBadge', 'Region: Default · {label}').replace(
                '{label}',
                regionLabel,
              )}
            </Badge>
          </div>
        </header>

        <section className="tm-dloc-section" aria-labelledby="tm-dloc-where-title">
          <h2 id="tm-dloc-where-title" className="tm-dloc-section__title">
            {tr('DataLocation.whereTitle', 'What lives where')}
          </h2>
          <table className="tm-dloc-table tm-dloc-table--where">
            <thead>
              <tr>
                <th scope="col">{tr('DataLocation.colData', 'Data')}</th>
                <th scope="col">{tr('DataLocation.colWhere', 'Where it lives')}</th>
                <th scope="col">{tr('DataLocation.colWho', 'Who processes it')}</th>
              </tr>
            </thead>
            <tbody>
              {LOCATION_ROWS.map(([key, data, where, who]) => (
                <tr key={key}>
                  <th scope="row">{tr(`DataLocation.row.${key}.data`, data)}</th>
                  <td>{tr(`DataLocation.row.${key}.where`, where)}</td>
                  <td>{tr(`DataLocation.row.${key}.who`, who)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TransferNotice
            title={tr(
              'DataLocation.transferTitle',
              'Your data is stored outside Saudi Arabia, the UAE and Egypt',
            )}
            body={tr(
              'DataLocation.transferBody',
              'Saudi Arabia: transferred outside the Kingdom under PDPL Article 29, with SDAIA standard contractual clauses attached. UAE: covered by contractual safeguards. Egypt: public bodies may need a transfer permit, so ask us before you sign.',
            )}
          />
        </section>

        <section
          id="subprocessors"
          className="tm-dloc-section"
          aria-labelledby="tm-dloc-subs-title"
        >
          <div className="tm-dloc-section__head">
            <div className="tm-dloc-section__text">
              <h2 id="tm-dloc-subs-title" className="tm-dloc-section__title">
                {tr('DataLocation.subsTitle', 'Subprocessors')}
              </h2>
              <p className="tm-dloc-section__lede">
                {tr(
                  'DataLocation.subsLede',
                  'We email account owners 30 days before we add or change a subprocessor.',
                )}
              </p>
            </div>
            <ButtonLink href={CHANGE_NOTICES_HREF} tone="outline" className="tm-dloc-button">
              {tr('DataLocation.changeNotices', 'Get change notices')}
            </ButtonLink>
          </div>
          <table className="tm-dloc-table tm-dloc-table--subs">
            <thead>
              <tr>
                <th scope="col">{tr('DataLocation.colSubprocessor', 'Subprocessor')}</th>
                <th scope="col">{tr('DataLocation.colDoes', 'What it does')}</th>
                <th scope="col">{tr('DataLocation.colPlace', 'Where')}</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSOR_ROWS.map(([key, name, does, place]) => (
                <tr key={key}>
                  <th scope="row">{tr(`DataLocation.sub.${key}.name`, name)}</th>
                  <td>{tr(`DataLocation.sub.${key}.does`, does)}</td>
                  <td>{tr(`DataLocation.sub.${key}.where`, place)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="tm-dloc-request" aria-labelledby="tm-dloc-request-title">
          <div className="tm-dloc-request__text">
            <h2 id="tm-dloc-request-title" className="tm-dloc-request__title">
              {tr('DataLocation.requestTitle', 'Need a Gulf region or self-hosting?')}
            </h2>
            <p className="tm-dloc-request__lede">
              {tr(
                'DataLocation.requestLede',
                'Tell us where your data must stay. We reply within two working days.',
              )}
            </p>
          </div>
          <ButtonLink href={REGION_REQUEST_HREF} tone="lime" className="tm-dloc-button">
            {tr('DataLocation.requestAction', 'Ask for a different region')}
          </ButtonLink>
        </section>
      </div>
    </div>
  );
}
