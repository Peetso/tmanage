'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTrailCsv, parseTrailCsv } from '../../lib/api/session-intel';
import type { TrailRow } from '../../lib/api/session-intel';
import { useT } from '../../lib/i18n/use-t';
import { reasonKey } from './SignalPill';
import './session-intel.css';

/** "2026-11-01 09:12 UTC" from an ISO instant; the input verbatim when it does not parse. */
export function formatUtc(iso: string): string {
  const at = new Date(iso);
  if (iso === '' || Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** jsdom implements `window.print` as a "not implemented" error; never call it there. */
function canPrint(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.print === 'function' &&
    !/jsdom/i.test(navigator.userAgent)
  );
}

function cell(row: TrailRow, key: string): string {
  const value = row[key];
  return value === undefined || value === '' ? '—' : value;
}

/**
 * **TrailPrintView** (Figma 503:29576) — an A4 page of a sign-in trail for "Save as PDF", built from
 * the same CSV the Download button saves, so the two can never disagree. Every time is UTC, said so
 * at the top, and the footer carries the honest limits and the DB-IP attribution. No PDF library:
 * the browser's print dialog saves it (R5's approach).
 */
export function TrailPrintView({
  subject,
  meta,
  csvUrl,
  autoPrint = true,
  fetchImpl,
  now = () => new Date(),
}: {
  subject: string;
  meta: string;
  csvUrl: string;
  autoPrint?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}) {
  const t = useT();
  const printed = useRef(false);
  const trail = useQuery({
    queryKey: ['session-trail', csvUrl],
    queryFn: async () => parseTrailCsv(await fetchTrailCsv(csvUrl, fetchImpl)),
    retry: false,
  });

  useEffect(() => {
    if (!autoPrint || !trail.isSuccess || printed.current || !canPrint()) return undefined;
    printed.current = true;
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [autoPrint, trail.isSuccess]);

  return (
    <article className="tm-trail-print">
      <div className="tm-trail-print__actions">
        <button
          type="button"
          className="tm-button tm-button--outline"
          onClick={() => {
            if (canPrint()) window.print();
          }}
        >
          {t('TrailPrint.print')}
        </button>
      </div>
      <p className="tm-trail-print__eyebrow">{t('TrailPrint.eyebrow')}</p>
      <h1 className="tm-trail-print__title">{subject}</h1>
      <p className="tm-trail-print__meta">{meta}</p>
      <p className="tm-trail-print__meta">
        {t('TrailPrint.utcNote')} {t('TrailPrint.printed')} {formatUtc(now().toISOString())}
      </p>
      {trail.isPending ? <p>{t('TrailPrint.loading')}</p> : null}
      {trail.isError ? <p role="alert">{t('TrailPrint.loadError')}</p> : null}
      {trail.isSuccess && trail.data.length === 0 ? <p>{t('TrailPrint.empty')}</p> : null}
      {trail.isSuccess && trail.data.length > 0 ? (
        <table className="tm-trail-print__table">
          <thead>
            <tr>
              <th scope="col">{t('TrailPrint.colTime')}</th>
              <th scope="col">{t('TrailPrint.colResult')}</th>
              <th scope="col">{t('TrailPrint.colIp')}</th>
              <th scope="col">{t('TrailPrint.colLocation')}</th>
              <th scope="col">{t('TrailPrint.colNetwork')}</th>
              <th scope="col">{t('TrailPrint.colDevice')}</th>
              <th scope="col">{t('TrailPrint.colSignal')}</th>
            </tr>
          </thead>
          <tbody>
            {trail.data.map((row, index) => (
              <tr key={`${cell(row, 'occurredAtUtc')}-${index}`}>
                <td>
                  <bdi dir="ltr">{formatUtc(row['occurredAtUtc'] ?? '')}</bdi>
                </td>
                <td>{[row['action'], row['outcome']].filter(Boolean).join(' · ') || '—'}</td>
                <td>
                  <bdi dir="ltr" className="tm-intel-mono">
                    {cell(row, 'ip')}
                  </bdi>
                </td>
                <td>
                  {[row['city'], row['country']].filter(Boolean).join(', ') || '—'}
                  {row['city'] || row['country'] ? ` (${t('SessionIntel.approx')})` : ''}
                </td>
                <td>
                  {[
                    row['networkOwner'],
                    row['asn'] ? `AS${row['asn']}` : '',
                    row['tor'] === 'true' ? 'Tor' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </td>
                <td>{[row['browser'], row['os']].filter(Boolean).join(' · ') || '—'}</td>
                <td>
                  {row['automationScore'] ? `${row['automationScore']} · ` : ''}
                  {(row['reasons'] ?? '')
                    .split(/[;|]/)
                    .map((code) => code.trim())
                    .filter(Boolean)
                    .map((code) => t(reasonKey(code)))
                    .join('; ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <footer className="tm-trail-print__footer">
        <p>
          {t('LocationHonesty.title')}: {t('LocationHonesty.approximate')}{' '}
          {t('LocationHonesty.vpn')} {t('LocationHonesty.mac')} {t('LocationHonesty.street')}
        </p>
        <p>{t('SessionIntel.attribution')}</p>
      </footer>
    </article>
  );
}
