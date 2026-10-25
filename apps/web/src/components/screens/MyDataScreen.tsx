'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { PreferencesNav } from './PreferencesScreen';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  cancelMyDeletion,
  myExportDownloadUrl,
  readMyPrivacy,
  requestMyDeletion,
  requestMyExport,
} from '../../lib/api/privacy';
import type { MyPrivacyView } from '../../lib/api/privacy';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  fill,
  isSameDay,
  privacyClock,
  privacyDay,
  privacySize,
} from '../../lib/privacy-presentation';
import '../../styles/screens/preferences.css';
import '../privacy/privacy.css';

export interface MyDataScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests. Defaults to the real API origin. */
  baseUrl?: string;
  /** Injected in tests. */
  now?: () => Date;
}

type Tr = (key: string, english: string) => string;

function writeErrorText(tr: Tr, error: unknown): string {
  if (error instanceof ApiRequestError) {
    const reason = error.details[0]?.message;
    if (error.status === 409 && reason === 'last_owner') {
      return tr(
        'MyDataScreen.errorLastOwner',
        'You are the only owner. Make someone else an owner before you delete your account.',
      );
    }
    if (error.status === 409 && reason === 'preparing') {
      return tr('MyDataScreen.errorPreparing', 'Your file is already being prepared.');
    }
    if (error.status === 409 && reason === 'scheduled') {
      return tr('MyDataScreen.errorScheduled', 'Your account deletion is already scheduled.');
    }
  }
  return tr('MyDataScreen.errorGeneric', 'That did not go through. Try again.');
}

/**
 * **My data** — the person's own copy and account deletion (Figma F5 phone, 392:5537), under the
 * account orb beside the other personal settings. Built phone-first; on a wide screen the two cards
 * sit in the preferences column. The archive is a plain download link to the API.
 */
export function MyDataScreen({
  organizationSlug,
  organizationName,
  client,
  baseUrl,
  now = () => new Date(),
}: MyDataScreenProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['my-privacy', organizationSlug], [organizationSlug]);

  const mine = useQuery({
    queryKey,
    queryFn: () => readMyPrivacy(api, organizationSlug),
    retry: false,
    refetchInterval: (query) => (query.state.data?.export?.state === 'preparing' ? 15_000 : false),
  });

  const settle = (data: MyPrivacyView) => queryClient.setQueryData(queryKey, data);
  const exportMine = useMutation({
    mutationFn: () => requestMyExport(api, organizationSlug),
    onSuccess: settle,
  });
  const deleteMine = useMutation({
    mutationFn: () => requestMyDeletion(api, organizationSlug),
    onSuccess: settle,
  });
  const cancelMine = useMutation({
    mutationFn: () => cancelMyDeletion(api, organizationSlug),
    onSuccess: settle,
  });

  const data = mine.data;
  const name = data?.organizationName ?? organizationName;
  const current = data?.export ?? null;
  const today = now();

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tr('MyDataScreen.eyebrow', 'Profile')}
      title={tr('MyDataScreen.title', 'My data')}
      description={tr(
        'MyDataScreen.description',
        'Get a copy of your personal data, or delete your account.',
      )}
      contextRail={<PreferencesNav organizationSlug={organizationSlug} current="my-data" />}
    >
      {mine.isPending ? (
        <LoadingRegion label={tr('MyDataScreen.loading', 'Loading your data settings')}>
          <div className="prv-mine">
            <Skeleton height="240px" />
            <Skeleton height="200px" />
          </div>
        </LoadingRegion>
      ) : !data ? (
        <InlineAlert tone="danger">
          {tr('MyDataScreen.loadError', 'Your data settings could not be loaded. Try again.')}
        </InlineAlert>
      ) : (
        <div className="prv-mine">
          <section className="prv-card prv-card--compact" aria-labelledby="prv-my-export">
            <div className="prv-card__head">
              <h2 id="prv-my-export" className="prv-card__title">
                {tr('MyDataScreen.exportTitle', 'Download my data')}
              </h2>
              <p className="prv-card__body">
                {tr(
                  'MyDataScreen.exportBody',
                  'Your profile, messages you wrote, files you added and sign-in history.',
                )}
              </p>
            </div>
            {current?.state === 'preparing' ? (
              <div className="prv-panel prv-panel--compact" role="status">
                <StatusDot tone="warning" className="prv-panel__state">
                  {tr('MyDataScreen.preparingTitle', 'Preparing your file')}
                </StatusDot>
                <p className="prv-panel__body">
                  {fill(
                    isSameDay(current.requestedAt, today)
                      ? tr(
                          'MyDataScreen.preparingBodyToday',
                          'Started today at {time}. We will email you when it is ready.',
                        )
                      : tr(
                          'MyDataScreen.preparingBodyDay',
                          'Started on {date}. We will email you when it is ready.',
                        ),
                    {
                      time: privacyClock(current.requestedAt),
                      date: privacyDay(current.requestedAt, locale),
                    },
                  )}
                </p>
              </div>
            ) : null}
            {current?.state === 'ready' ? (
              <div className="prv-panel prv-panel--compact">
                <StatusDot tone="success" className="prv-panel__state">
                  {fill(tr('MyDataScreen.readyTitle', 'Ready to download · {size}'), {
                    size: privacySize(current.sizeBytes),
                  })}
                </StatusDot>
                <p className="prv-panel__body">
                  {fill(tr('MyDataScreen.readyBody', 'The link works until {date}.'), {
                    date: privacyDay(current.expiresAt ?? current.requestedAt, locale),
                  })}
                </p>
              </div>
            ) : null}
            {current?.state === 'ready' ? (
              <a
                className="tm-button tm-button--ink tm-button--default prv-wide"
                href={myExportDownloadUrl(baseUrl ?? apiBaseUrl(), organizationSlug, current.id)}
              >
                {tr('MyDataScreen.download', 'Download')}
              </a>
            ) : (
              <Button
                tone="ink"
                className="prv-wide"
                disabled={current?.state === 'preparing'}
                loading={exportMine.isPending}
                loadingLabel={tr('MyDataScreen.starting', 'Asking for your data')}
                onClick={() => exportMine.mutate()}
              >
                {tr('MyDataScreen.requestExport', 'Request my data')}
              </Button>
            )}
            {exportMine.error ? (
              <InlineAlert tone="danger" live>
                {writeErrorText(tr, exportMine.error)}
              </InlineAlert>
            ) : null}
          </section>

          <section className="prv-card prv-card--compact" aria-labelledby="prv-my-delete">
            <div className="prv-card__head">
              <h2 id="prv-my-delete" className="prv-card__title">
                {tr('MyDataScreen.deleteTitle', 'Delete my account')}
              </h2>
              {data.deletion ? null : (
                <p className="prv-card__body">
                  {fill(
                    tr(
                      'MyDataScreen.deleteBody',
                      'Removes your profile and sign-in from {org}. Work you shared stays with the team, shown as Former member. You get {days} days to change your mind.',
                    ),
                    { org: name, days: data.gracePeriodDays },
                  )}
                </p>
              )}
            </div>
            {data.deletion ? (
              <>
                <InlineAlert tone="danger">
                  {fill(
                    tr(
                      'MyDataScreen.deletionScheduled',
                      'Your account will be deleted on {date}. You can still sign in and work until then.',
                    ),
                    { date: privacyDay(data.deletion.scheduledFor, locale) },
                  )}
                </InlineAlert>
                <Button
                  tone="outline"
                  className="prv-wide"
                  loading={cancelMine.isPending}
                  loadingLabel={tr('MyDataScreen.cancelling', 'Cancelling the deletion')}
                  onClick={() => cancelMine.mutate()}
                >
                  {tr('MyDataScreen.cancelDeletion', 'Cancel deletion')}
                </Button>
              </>
            ) : (
              <Button
                tone="destructive"
                className="prv-wide"
                loading={deleteMine.isPending}
                loadingLabel={tr('MyDataScreen.requesting', 'Asking to delete your account')}
                onClick={() => deleteMine.mutate()}
              >
                {tr('MyDataScreen.deleteAccount', 'Delete my account')}
              </Button>
            )}
            {deleteMine.error || cancelMine.error ? (
              <InlineAlert tone="danger" live>
                {writeErrorText(tr, deleteMine.error ?? cancelMine.error)}
              </InlineAlert>
            ) : null}
          </section>
        </div>
      )}
    </AppShell>
  );
}
