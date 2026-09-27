'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listBillingCredits, postBillingCredit } from '../../lib/api/billing-credits';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface BillingCreditsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Billing credits (Billing module 19, x226).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing (credits / adjustments). This screen owns the
 * organization's manual credit ledger — each entry a signed amount (a positive credit or a negative
 * adjustment), a reason, and when it was posted — and shows the running balance. It is disjoint from
 * the billing profile, contacts and usage-alerts screens.
 *
 * The reads and writes are gated on the server by `org.manage` — owners only — so a member who opens
 * this screen sees the API's 403 rather than a blank page. This is bookkeeping only: posting a credit
 * records a row, it moves no money and settles no invoice (real settlement is Needs-Peter), and a
 * posted credit cannot be edited or removed — a correction is a new, offsetting entry.
 */
export function BillingCreditsScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingCreditsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const credits = useQuery({
    queryKey: ['billing-credits', organizationSlug],
    queryFn: () => listBillingCredits(api, organizationSlug),
  });

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['billing-credits', organizationSlug] });

  const minorUnits = toMinorUnits(amount);

  const post = useMutation({
    mutationFn: () =>
      postBillingCredit(api, organizationSlug, { amount: minorUnits ?? 0, reason: reason.trim() }),
    onSuccess: async () => {
      setAmount('');
      setReason('');
      await invalidate();
    },
  });

  const rows = credits.data?.credits ?? [];
  const balance = credits.data?.balance ?? 0;
  const canPost =
    minorUnits !== null && minorUnits !== 0 && reason.trim() !== '' && !post.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Billing credits"
      description="Record manual credits and adjustments against this organization's account."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-credit-add-heading">
        <h2 id="tm-credit-add-heading" className="tm-eyebrow">
          Post a credit or adjustment
        </h2>
        <p className="tm-muted">
          Current balance: <strong>{formatCurrency(balance)}</strong>
        </p>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canPost) post.mutate();
          }}
        >
          <Field
            label="Amount"
            name="amount"
            type="number"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            hint="In your billing currency. A negative amount records an adjustment."
            required
          />
          <Field
            label="Reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Why this credit is being posted — e.g. Goodwill credit, Overbill adjustment."
            required
          />

          {post.isError ? (
            <InlineAlert tone="danger" title="Could not post the credit" live>
              {describeError(post.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={post.isPending}
              loadingLabel="Posting"
              disabled={!canPost}
            >
              Post credit
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-credit-list-heading"
      >
        <h2 id="tm-credit-list-heading" className="tm-eyebrow">
          Ledger {credits.isSuccess ? `(${rows.length})` : ''}
        </h2>

        {credits.isError ? (
          <InlineAlert tone="danger" title="Could not load the credits" live>
            {describeError(credits.error)}
          </InlineAlert>
        ) : null}

        {credits.isPending ? (
          <LoadingRegion label="Loading the credit ledger.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {credits.isSuccess && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No credits yet">
            Post a credit or adjustment above to start the ledger.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              The organization&rsquo;s credit and adjustment ledger, newest first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Posted</th>
                <th scope="col">Reason</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((credit) => (
                <tr key={credit.id}>
                  <td>{new Date(credit.createdAt).toLocaleString()}</td>
                  <td>{credit.reason}</td>
                  <td>{formatCurrency(credit.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Parse a currency string into integer minor units, or null when it is not a finite number. */
function toMinorUnits(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Render integer minor units as a currency amount (two decimal places, no symbol). */
function formatCurrency(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
