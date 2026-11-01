'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readAuditRetention, setAuditRetention } from '../../lib/api/admin-audit-retention';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

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
  const t = useT();

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
      : `${t('AuditRetentionView.fieldErrorPrefix')} ${MAX_RETENTION_DAYS}.`;

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
      title={t('AuditRetentionView.title')}
      description={t('AuditRetentionView.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-audit-retention-heading">
        <h2 id="tm-audit-retention-heading" className="tm-eyebrow">
          {t('AuditRetentionView.retention')}
        </h2>

        {policy.isError ? (
          <InlineAlert tone="danger" title={t('AuditRetentionView.errorLoadTitle')} live>
            {describeError(t, policy.error)}
          </InlineAlert>
        ) : null}

        {policy.isPending ? (
          <LoadingRegion label={t('AuditRetentionView.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!policy.isPending && !policy.isError ? (
          <form
            className="tm-stack"
            noValidate
            aria-label={t('AuditRetentionView.formLabel')}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setSaved(false);
              if (daysValid && !save.isPending) save.mutate();
            }}
          >
            <Field
              label={t('AuditRetentionView.fieldLabel')}
              name="retention-days"
              type="number"
              inputMode="numeric"
              value={daysText}
              onChange={(event) => {
                setSaved(false);
                setDaysText(event.target.value);
              }}
              hint={`${t('AuditRetentionView.fieldHintPrefix')} ${MAX_RETENTION_DAYS}.`}
              error={daysError}
              disabled={save.isPending}
            />

            <p className="tm-muted" aria-live="polite">
              {policy.data.retentionDays === null
                ? t('AuditRetentionView.noWindow')
                : `${policy.data.eventsOlderThanWindow.toLocaleString(appLocale())} ${
                    policy.data.eventsOlderThanWindow === 1
                      ? t('AuditRetentionView.eventOne')
                      : t('AuditRetentionView.eventMany')
                  } ${t('AuditRetentionView.olderMid')} ${policy.data.retentionDays}${t('AuditRetentionView.olderDaySuffix')}`}
            </p>
            <p className="tm-muted">{t('AuditRetentionView.savingNote')}</p>

            {save.isError ? (
              <InlineAlert tone="danger" title={t('AuditRetentionView.errorSaveTitle')} live>
                {describeError(t, save.error)}
              </InlineAlert>
            ) : null}
            {saved && !save.isPending && !save.isError ? (
              <InlineAlert tone="success" title={t('AuditRetentionView.savedTitle')} live>
                {t('AuditRetentionView.savedBody')}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={!daysValid}
                loading={save.isPending}
                loadingLabel={t('AuditRetentionView.saving')}
              >
                {t('AuditRetentionView.save')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AuditRetentionView.errorApiUnreachable');
  return t('AuditRetentionView.errorGeneric');
}
