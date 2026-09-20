'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
  const api = client ?? browserApiClient();

  const receipt = useQuery({
    queryKey: ['import-receipt', organizationSlug, jobId],
    queryFn: () => fetchImportReceipt(api, organizationSlug, jobId),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Import receipt"
      description="What happened to this import and to each row it committed."
    >
      {receipt.isPending ? (
        <LoadingRegion label="Loading import receipt." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {receipt.isError ? (
        <InlineAlert tone="danger" title="Could not load the import receipt" live>
          {describe(receipt.error)}
        </InlineAlert>
      ) : null}

      {receipt.isSuccess ? <ReceiptPanel receipt={receipt.data} /> : null}
    </AppShell>
  );
}

function ReceiptPanel({ receipt }: { receipt: ImportReceipt }) {
  const statusText =
    receipt.status === 'committed' ? 'Committed' : 'Committed with errors';
  const statusState = receipt.status === 'committed' ? 'done' : 'blocked';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-receipt-heading">
      <h2 id="tm-receipt-heading" className="tm-eyebrow">
        This import
      </h2>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Status</dt>
          <dd>
            <StateCapsule state={statusState}>{statusText}</StateCapsule>
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Committed</dt>
          <dd className="tm-mono">{receipt.committedCount}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Failed</dt>
          <dd className="tm-mono">{receipt.failedCount}</dd>
        </div>
      </dl>

      <RowsTable rows={receipt.rows} />
    </section>
  );
}

function RowsTable({ rows }: { rows: readonly ImportReceiptRow[] }) {
  if (rows.length === 0) {
    return <p className="tm-prose">This import committed no rows.</p>;
  }

  return (
    <div className="tm-table-scroll" role="region" aria-label="Imported rows">
      <table className="tm-table">
        <caption className="tm-visually-hidden">
          Each source row and what the import did with it, in source order.
        </caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Outcome</th>
            <th scope="col">Result</th>
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
                  <StateCapsule state="done">Created</StateCapsule>
                ) : (
                  <StateCapsule state="blocked">Failed</StateCapsule>
                )}
              </td>
              <td>
                {row.outcome === 'created' ? (
                  <span className="tm-mono">{row.createdEntityId}</span>
                ) : (
                  <span className="tm-prose">{row.error ?? 'No detail recorded.'}</span>
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
