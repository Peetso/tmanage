'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchImportReceipt } from '../../lib/api/imports';
import type { ImportReceipt, ImportReceiptRow } from '../../lib/api/imports';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ImportReceiptScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The committed `import_jobs` id whose receipt to read. */
  jobId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Import receipt** — the screen ON-09 ("progress" / partial failure) and ADM-10 ("receipt")
 * ask for: after a committed import, show what happened to the job and to each source row. The
 * commit half (x100) recorded the receipt in `import_jobs` + `import_rows`; the read half (x104)
 * serves it at `GET /v1/organizations/:orgSlug/imports/:jobId/receipt`, and this is the screen
 * that renders it.
 *
 * Three decisions worth stating:
 *
 * 1. **No rail item.** `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and
 *    an import receipt is not one of them, so — exactly as `StorageUsageScreen` did for billing —
 *    none is invented. The screen has its own route (`/onboarding/import/:jobId`) and is reached
 *    from there.
 * 2. **Authorization is the API's.** The read sits behind `org.manage`; a caller without it gets
 *    the ordinary 403, which `describe()` turns into a line. The screen never guesses a capability
 *    of its own and never renders blank on a refusal.
 * 3. **The per-row list is a real table.** Each source row is a row of a `<table>` with column
 *    headers and a row header on the source index, so a screen reader announces "row 1, created"
 *    rather than a flat run of cells — the receipt's whole point is auditability.
 */
export function ImportReceiptScreen({
  organizationSlug,
  organizationName,
  jobId,
  client,
}: ImportReceiptScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();

  const receipt = useQuery({
    queryKey: ['import-receipt', organizationSlug, jobId],
    queryFn: () => fetchImportReceipt(api, organizationSlug, jobId),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('ImportReceiptScreen.title')}
      titleVariant="display"
      eyebrow={t('ImportReceiptScreen.eyebrow')}
      description={t('ImportReceiptScreen.description')}
    >
      <style href="tm-onboarding-import" precedence="default">
        {IMPORT_CSS}
      </style>

      {receipt.isPending ? (
        <LoadingRegion label={t('ImportReceiptScreen.loading')} className="tm-import">
          <Skeleton height="48px" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {receipt.isError ? (
        <InlineAlert tone="danger" title={t('ImportReceiptScreen.loadErrorTitle')} live>
          {describe(receipt.error)}
        </InlineAlert>
      ) : null}

      {receipt.isSuccess ? <ReceiptPanel receipt={receipt.data} /> : null}
    </AppShell>
  );
}

function ReceiptPanel({ receipt }: { receipt: ImportReceipt }) {
  const t = useT();
  const statusText =
    receipt.status === 'committed'
      ? t('ImportReceiptScreen.statusCommitted')
      : t('ImportReceiptScreen.statusCommittedErrors');
  const statusState = receipt.status === 'committed' ? 'done' : 'blocked';
  const total = receipt.committedCount + receipt.failedCount;
  const failures = groupFailures(receipt.rows);

  return (
    <div className="tm-import">
      <ol className="tm-import__track" aria-label={t('ImportReceiptScreen.stepsLabel')}>
        <li className="tm-import__capsule tm-import__capsule--ink">
          {t('ImportReceiptScreen.stepValidate')}
        </li>
        <li className="tm-import__capsule tm-import__capsule--ink">
          {t('ImportReceiptScreen.stepCommit')}
        </li>
        <li className="tm-import__capsule tm-import__capsule--lime" aria-current="step">
          <span className="tm-import__capsule-key">{t('ImportReceiptScreen.stepReceipt')}</span>
          <span className="tm-import__capsule-text">
            {receipt.committedCount} {t('ImportReceiptScreen.of')} {total}{' '}
            {total === 1 ? t('ImportReceiptScreen.record') : t('ImportReceiptScreen.records')}{' '}
            {t('ImportReceiptScreen.committed')}
          </span>
        </li>
      </ol>

      <div className="tm-import__grid">
        <section className="tm-import__card" aria-labelledby="tm-receipt-heading">
          <h2 id="tm-receipt-heading" className="tm-import__eyebrow">
            {t('ImportReceiptScreen.thisImport')}
          </h2>

          <dl className="tm-detail-list tm-import__summary">
            <div className="tm-detail-list__pair">
              <dt>{t('ImportReceiptScreen.statusLabel')}</dt>
              <dd>
                <StateCapsule state={statusState}>{statusText}</StateCapsule>
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>{t('ImportReceiptScreen.committedLabel')}</dt>
              <dd className="tm-mono">{receipt.committedCount}</dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>{t('ImportReceiptScreen.failedLabel')}</dt>
              <dd className="tm-mono">{receipt.failedCount}</dd>
            </div>
          </dl>

          <div className="tm-import__bars" aria-hidden="true">
            <ProgressBar
              label={t('ImportReceiptScreen.committedLabel')}
              value={receipt.committedCount}
              total={total}
            />
            <ProgressBar
              label={t('ImportReceiptScreen.failedLabel')}
              value={receipt.failedCount}
              total={total}
              tone="warning"
            />
          </div>

          <hr className="tm-import__rule" />
          <p className="tm-import__note">
            {t('ImportReceiptScreen.notePrefix')}{' '}
            <strong>{t('ImportReceiptScreen.noteInternal')}</strong>{' '}
            {t('ImportReceiptScreen.noteSuffix')}
          </p>
        </section>

        {receipt.failedCount > 0 ? (
          <section
            className="tm-import__card tm-import__card--warning"
            aria-labelledby="tm-receipt-failures"
          >
            <div className="tm-import__failure-head">
              <span className="tm-import__glyph" aria-hidden="true">
                !
              </span>
              <h2 id="tm-receipt-failures" className="tm-import__failure-title">
                {t('ImportReceiptScreen.partialFailure')} · {receipt.failedCount}{' '}
                {receipt.failedCount === 1
                  ? t('ImportReceiptScreen.record')
                  : t('ImportReceiptScreen.records')}
              </h2>
            </div>
            <p className="tm-import__note">{t('ImportReceiptScreen.failureNote')}</p>
            <ul className="tm-import__reasons">
              {failures.map((failure) => (
                <li key={failure.reason}>
                  {`${failure.count} ${failure.count === 1 ? t('ImportReceiptScreen.row') : t('ImportReceiptScreen.rows')} · ${failure.reason}`}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <section className="tm-import__card" aria-labelledby="tm-receipt-rows">
        <h2 id="tm-receipt-rows" className="tm-import__eyebrow">
          {t('ImportReceiptScreen.rowByRow')}
        </h2>
        <RowsTable rows={receipt.rows} />
      </section>
    </div>
  );
}

function ProgressBar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone?: 'warning';
}) {
  const share = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div className="tm-import__bar">
      <span className="tm-import__bar-label">{label}</span>
      <span className="tm-import__bar-track">
        <span
          className="tm-import__bar-fill"
          data-tone={tone}
          style={{ inlineSize: `${share}%` }}
        />
      </span>
      <span className="tm-import__bar-count">
        {value} / {total}
      </span>
    </div>
  );
}

/** Failed rows grouped by their reason, most frequent first — the export's "18 items · …" list. */
function groupFailures(rows: readonly ImportReceiptRow[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== 'failed') continue;
    const reason = row.error ?? 'No detail recorded.';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function RowsTable({ rows }: { rows: readonly ImportReceiptRow[] }) {
  const t = useT();
  if (rows.length === 0) {
    return <p className="tm-prose">{t('ImportReceiptScreen.noRows')}</p>;
  }

  return (
    <div className="tm-table-scroll" role="region" aria-label={t('ImportReceiptScreen.rowsLabel')}>
      <table className="tm-table">
        <caption className="tm-visually-hidden">{t('ImportReceiptScreen.rowsCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ImportReceiptScreen.colRow')}</th>
            <th scope="col">{t('ImportReceiptScreen.colOutcome')}</th>
            <th scope="col">{t('ImportReceiptScreen.colResult')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceIndex}>
              <th scope="row" className="tm-mono">
                {row.sourceIndex + 1}
              </th>
              <td>
                {row.outcome === 'created' ? (
                  <StateCapsule state="done">{t('ImportReceiptScreen.created')}</StateCapsule>
                ) : (
                  <StateCapsule state="blocked">{t('ImportReceiptScreen.failed')}</StateCapsule>
                )}
              </td>
              <td>
                {row.outcome === 'created' ? (
                  <span className="tm-mono">{row.createdEntityId}</span>
                ) : (
                  <span className="tm-prose">{row.error ?? t('ImportReceiptScreen.noDetail')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

const IMPORT_CSS = `
.tm-import { display: flex; flex-direction: column; gap: 18px; }
.tm-import__track { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 0; list-style: none; }
.tm-import__capsule {
  display: inline-flex; align-items: center; gap: 12px; min-block-size: 48px; padding: 0 18px;
  border: var(--b-quiet) dashed var(--line-300); border-radius: var(--r-capsule); color: var(--ink-500);
  font-size: var(--t-caption); line-height: var(--t-caption-line); font-weight: 500; white-space: nowrap;
}
.tm-import__capsule--ink { border: 0; background: var(--tm-ink-absolute); color: var(--tm-paper-absolute); }
.tm-import__capsule--lime { flex: 1; border: 0; padding-inline: 20px; background: var(--lime-500); color: var(--tm-on-lime); }
.tm-import__capsule-key { font-size: 11px; line-height: 15px; font-weight: 600; text-transform: uppercase; }
.tm-import__capsule-text { font-size: var(--t-ui-sm); line-height: var(--t-ui-sm-line); font-weight: 600; white-space: normal; }
.tm-import__grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; }
.tm-import__grid > :only-child { grid-column: 1 / -1; }
.tm-import__card {
  display: flex; flex-direction: column; gap: 14px; min-inline-size: 0; padding: 22px;
  border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); background: var(--paper-0);
}
.tm-import__card--warning { border: var(--b-structural) solid var(--warning-600); }
.tm-import__eyebrow {
  margin: 0; font-family: var(--font-mono); font-size: 10px; line-height: 14px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-500);
}
.tm-import__summary { margin: 0; }
.tm-import__bars { display: flex; flex-direction: column; gap: 12px; }
.tm-import__bar { display: flex; align-items: center; gap: 12px; }
.tm-import__bar-label { inline-size: 96px; font-size: var(--t-caption); line-height: var(--t-caption-line); font-weight: 500; color: var(--ink-800); }
.tm-import__bar-track { flex: 1; block-size: 12px; overflow: hidden; border-radius: var(--r-capsule); background: var(--paper-150); }
.tm-import__bar-fill { display: block; block-size: 100%; background: var(--ink-950); }
.tm-import__bar-fill[data-tone='warning'] { background: var(--warning-600); }
.tm-import__bar-count { inline-size: 74px; text-align: end; font-family: var(--font-mono); font-size: 11px; line-height: 15px; color: var(--ink-950); }
.tm-import__rule { block-size: 1px; margin: 0; border: 0; background: var(--paper-150); }
.tm-import__note { margin: 0; font-size: var(--t-ui-sm); line-height: 19px; color: var(--ink-650); text-wrap: pretty; }
.tm-import__note strong { font-weight: 500; color: var(--ink-950); }
.tm-import__failure-head { display: flex; align-items: center; gap: 10px; }
.tm-import__glyph {
  display: grid; place-items: center; inline-size: 24px; block-size: 24px; border: var(--b-expressive) solid var(--warning-600);
  border-radius: var(--r-capsule); color: var(--warning-600); font: 600 11px/1 var(--font-mono);
}
.tm-import__failure-title { margin: 0; font-size: var(--t-body-md); line-height: 21px; font-weight: 600; color: var(--ink-800); }
.tm-import__reasons { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tm-import__reasons li {
  padding: 10px 12px; border-radius: 12px; background: var(--paper-50); font-size: var(--t-caption);
  line-height: var(--t-caption-line); font-weight: 500; color: var(--ink-800); overflow-wrap: anywhere;
}
.tm-import .tm-table-scroll { border: 0; }
@media (max-width: 60rem) {
  .tm-import__grid { grid-template-columns: minmax(0, 1fr); }
  .tm-import__capsule--lime { flex-basis: 100%; }
}
`;
