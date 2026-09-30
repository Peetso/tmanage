'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readAuditRetention, setAuditRetention } from '../../lib/api/admin-audit-retention';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AuditRetentionViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The window ceiling, mirrored from the API's `MAX_RETENTION_DAYS`. */
const MAX_RETENTION_DAYS = 3650;

/**
 * **Audit-log retention policy (Administration module 18, x279).**
 *
 * `04-SECURITY-PRIVACY` §retention. This screen reads the organization's audit-log retention window —
 * how many days it keeps its audit events — and a read-only preview of how many events already fall
 * outside that window, and lets an org admin set the window (1..3650 days).
 *
 * It is a preview + policy surface only: setting a window does **not** delete anything. The screen says
 * so in as many words — the destructive purge is a later, separately-run procedure — so an administrator
 * is never surprised into losing their audit trail by saving a shorter window here.
 */
export function AuditRetentionView({
  organizationSlug,
  organizationName,
  client,
}: AuditRetentionViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const policy = useQuery({
    queryKey: ['admin-audit-retention', organizationSlug],
    queryFn: () => readAuditRetention(api, organizationSlug),
  });

  const [daysText, setDaysText] = useState('');
  const [saved, setSaved] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed the editable field from the loaded policy once it arrives, without clobbering later edits.
  useEffect(() => {
    if (!policy.data || seeded) return;
    setDaysText(policy.data.retentionDays === null ? '' : String(policy.data.retentionDays));
    setSeeded(true);
  }, [policy.data, seeded]);

  const parsed = Number(daysText.trim());
  const daysValid =
    daysText.trim() !== '' &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_RETENTION_DAYS;
  const daysError =
    daysText.trim() === '' || daysValid
      ? undefined
      : `Enter a whole number of days between 1 and ${MAX_RETENTION_DAYS}.`;

  const save = useMutation({
    mutationFn: () => setAuditRetention(api, organizationSlug, { retentionDays: parsed }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ['admin-audit-retention', organizationSlug],
      });
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Audit-log retention"
      description="How long this organization keeps its audit events. Setting a window does not delete anything."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-audit-retention-heading">
        <h2 id="tm-audit-retention-heading" className="tm-eyebrow">
          Retention
        </h2>

        {policy.isError ? (
          <InlineAlert tone="danger" title="Could not load the retention policy" live>
            {describeError(policy.error)}
          </InlineAlert>
        ) : null}

        {policy.isPending ? (
          <LoadingRegion label="Loading the retention policy.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!policy.isPending && !policy.isError ? (
          <form
            className="tm-stack"
            noValidate
            aria-label="Audit-log retention"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setSaved(false);
              if (daysValid && !save.isPending) save.mutate();
            }}
          >
            <Field
              label="Retention window (days)"
              name="retention-days"
              type="number"
              inputMode="numeric"
              value={daysText}
              onChange={(event) => {
                setSaved(false);
                setDaysText(event.target.value);
              }}
              hint={`How many days of audit events to keep, between 1 and ${MAX_RETENTION_DAYS}.`}
              error={daysError}
              disabled={save.isPending}
            />

            <p className="tm-muted" aria-live="polite">
              {policy.data.retentionDays === null
                ? 'No retention window is set yet, so no events are outside a window.'
                : `${policy.data.eventsOlderThanWindow.toLocaleString()} event${
                    policy.data.eventsOlderThanWindow === 1 ? '' : 's'
                  } older than the current ${policy.data.retentionDays}-day window.`}
            </p>
            <p className="tm-muted">
              Saving a window records the policy only. Events outside it are not removed now — a
              purge runs later as a separate, deliberate step.
            </p>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save the retention policy" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
            {saved && !save.isPending && !save.isError ? (
              <InlineAlert tone="success" title="Saved" live>
                The retention window has been updated. No events were deleted.
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={!daysValid}
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Save
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
