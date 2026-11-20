'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_OUTREACH_QUERY_KEY,
  fetchOutreach,
  importOutreach,
  markOutreachBounced,
  moveOutreachCampaign,
} from '../../../lib/api/platform-outreach';
import type {
  OutreachAction,
  OutreachCampaignView,
  OutreachExclusion,
  OutreachImportView,
  OutreachRecipientView,
  OutreachView,
} from '../../../lib/api/platform-outreach';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { PlatformGate, isStepUpLapse } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { SettingsSubNav, fill, formatWhen } from './settings-kit';

/**
 * LANE-Q · Settings -> Outreach (`/platform/settings/outreach`). Platform admins import the
 * decision-makers CSV (a new campaign, created PAUSED), see who will be written to and who was
 * left out and why, and start, pause or stop it. The worker sends from each person's own mailbox,
 * 5 / 10 / 20 a day per mailbox, 09:00-17:00 in the recipient's time zone. No address is ever
 * shown here: recipients are listed by company and first name.
 */

/** English copy; other languages arrive with the i18n fragment (`PlatformOutreach.*`). */
export const OUTREACH_COPY = {
  nav: 'Outreach',
  title: 'Outreach',
  description:
    'Introductions from the team, one person to one decision-maker, from each person’s own mailbox. A new list is created paused: nothing is sent until you press Start.',
  loading: 'Loading outreach',
  importTitle: 'Import a list',
  importLead:
    'The decision-makers CSV: company, country, segment, person_name, title, work_email, source_url, checked_at_utc, notes. Germany, Denmark and Norway are left out (prior consent needed), so are flagged rows and a second person at the same company.',
  fileLabel: 'CSV file',
  nameLabel: 'Campaign name (optional)',
  importButton: 'Import as a paused campaign',
  importing: 'Importing…',
  importedLine: '{imported} of {rows} rows imported. Nothing has been sent.',
  excludedTitle: 'Left out',
  noPostal:
    'No postal address is set (CAMPAIGN_POSTAL_ADDRESS), so US rows are left out at import and US recipients are not written to.',
  pace: 'Pace per mailbox: 5 a day in week 1, 10 in week 2, then 20, never more. Only 09:00–17:00 in the recipient’s time zone.',
  campaigns: 'Campaigns',
  noCampaigns: 'No campaign yet. Import a list to create one.',
  colName: 'Campaign',
  colStatus: 'Status',
  colCreated: 'Created',
  colQueued: 'Queued',
  colSent: 'Sent',
  colFailed: 'Failed',
  colSuppressed: 'Left out at send',
  colBounced: 'Bounced',
  colTrials: 'Trials started',
  colAction: 'Action',
  status_paused: 'Paused',
  status_running: 'Running',
  status_stopped: 'Stopped',
  start: 'Start',
  pause: 'Pause',
  stop: 'Stop',
  confirmStartTitle: 'Start “{name}”?',
  confirmStartBody:
    'Introductions start going out within five minutes, from each sender’s own mailbox, at the pace above. You can pause at any time.',
  confirmStopTitle: 'Stop “{name}”?',
  confirmStopBody: 'A stopped campaign cannot be started again. Nobody still queued is written to.',
  confirm: 'Confirm',
  cancel: 'Cancel',
  working: 'Working…',
  recipients: 'Recipients of the newest campaign',
  noRecipients: 'No recipients.',
  colCompany: 'Company',
  colFirstName: 'First name',
  colCountry: 'Country',
  colSender: 'Sender',
  colRecipientStatus: 'Status',
  colSentAt: 'Sent',
  colTrial: 'Trial',
  trialYes: 'Started',
  markBounced: 'Mark bounced',
  r_queued: 'Queued',
  r_sending: 'Sending',
  r_sent: 'Sent',
  r_failed: 'Failed',
  r_suppressed: 'Left out (unsubscribed or bounced)',
  r_bounced: 'Bounced',
  x_consent_country: 'Country needs prior consent (DE, DK, NO)',
  x_us_without_postal_address: 'US without a postal address',
  x_unknown_country: 'Unknown country',
  x_no_name: 'No first name',
  x_bad_email: 'Not a valid address',
  x_flagged: 'Flagged in the notes',
  x_contact_type: 'Not a named person',
  x_duplicate_address: 'Address already imported',
  x_second_at_company: 'Second person at the same company',
} as const;

type CopyName = keyof typeof OUTREACH_COPY;

function useCopy(): (name: CopyName, values?: Readonly<Record<string, string | number>>) => string {
  const tOr = useTOr();
  return (name, values) => {
    const text = tOr(`PlatformOutreach.${name}`, OUTREACH_COPY[name]);
    return values === undefined ? text : fill(text, values);
  };
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function PlatformOutreachScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const copy = useCopy();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), copy('title')]}
      title={copy('title')}
      description={copy('description')}
    >
      {(me) => <OutreachBody api={api} me={me} />}
    </PlatformGate>
  );
}

function OutreachBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const copy = useCopy();
  const outreach = useQuery({
    queryKey: PLATFORM_OUTREACH_QUERY_KEY,
    queryFn: () => fetchOutreach(api),
    // While a campaign runs, the counts follow the worker's five-minute passes.
    refetchInterval: (query) =>
      query.state.data?.campaigns.some((c) => c.status === 'running') ? 60_000 : false,
  });

  if (outreach.isPending) {
    return (
      <>
        <SettingsSubNav active="outreach" />
        <PlatformPageState state="loading" loadingLabel={copy('loading')} />
      </>
    );
  }
  if (outreach.isError) {
    const missing = missingPlatformPermission(outreach.error);
    return (
      <>
        <SettingsSubNav active="outreach" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState
            state="error"
            error={outreach.error}
            onRetry={() => void outreach.refetch()}
          />
        )}
      </>
    );
  }
  const view = outreach.data;
  return (
    <div className="tm-stack">
      <SettingsSubNav active="outreach" />
      {view.postalAddressSet ? null : <InlineAlert tone="neutral">{copy('noPostal')}</InlineAlert>}
      <ImportCard api={api} />
      <p className="tm-cc-card__lead">{copy('pace')}</p>
      <CampaignTable api={api} view={view} />
      <RecipientTable api={api} view={view} />
    </div>
  );
}

function useStepUpAware() {
  const queryClient = useQueryClient();
  return {
    queryClient,
    onError: (error: unknown) => {
      if (isStepUpLapse(error))
        void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    },
  };
}

function ImportCard({ api }: { api: ApiClient }) {
  const copy = useCopy();
  const t = useT();
  const { queryClient, onError } = useStepUpAware();
  const [csv, setCsv] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<OutreachImportView | null>(null);
  const run = useMutation({
    mutationFn: (input: { csv: string; name?: string }) => importOutreach(api, input),
    onSuccess: (view) => {
      const { imported: _i, rows: _r, excluded: _e, ...rest } = view;
      queryClient.setQueryData<OutreachView>(PLATFORM_OUTREACH_QUERY_KEY, rest);
      setResult(view);
    },
    onError,
  });

  function pick(event: ChangeEvent<HTMLInputElement>) {
    setResult(null);
    setFileError(null);
    const file = event.target.files?.[0];
    if (file === undefined) {
      setCsv(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setCsv(null);
      setFileError(t('PlatformShared.genericError'));
      return;
    }
    void file.text().then(setCsv);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (csv === null) return;
    run.mutate({ csv, ...(name.trim() === '' ? {} : { name: name.trim() }) });
  }

  const excluded = Object.entries(result?.excluded ?? {}) as [OutreachExclusion, number][];
  return (
    <section className="tm-cc-card tm-stack">
      <h2 className="tm-cc-card__title">{copy('importTitle')}</h2>
      <p className="tm-cc-card__lead">{copy('importLead')}</p>
      <form noValidate className="tm-stack tm-stack--tight" onSubmit={submit}>
        <label className="tm-stack tm-stack--tight">
          <span className="tm-cc-eyebrow">{copy('fileLabel')}</span>
          <input type="file" accept=".csv,text/csv" onChange={pick} />
        </label>
        <label className="tm-stack tm-stack--tight">
          <span className="tm-cc-eyebrow">{copy('nameLabel')}</span>
          <input
            className="tm-input"
            type="text"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div>
          <Button type="submit" tone="lime" disabled={csv === null || run.isPending}>
            {run.isPending ? copy('importing') : copy('importButton')}
          </Button>
        </div>
      </form>
      {fileError !== null ? (
        <InlineAlert tone="danger" live>
          {fileError}
        </InlineAlert>
      ) : null}
      {run.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(run.error, t)}
        </InlineAlert>
      ) : null}
      {result !== null ? (
        <InlineAlert tone="neutral" live>
          {copy('importedLine', { imported: result.imported, rows: result.rows })}
        </InlineAlert>
      ) : null}
      {excluded.length > 0 ? (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-eyebrow">{copy('excludedTitle')}</span>
          <ul>
            {excluded.map(([reason, count]) => (
              <li key={reason}>
                {copy(`x_${reason}`)}: <bdi>{count}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const count = (campaign: OutreachCampaignView, status: string) => campaign.counts[status] ?? 0;

const ACTIONS: Readonly<Record<OutreachCampaignView['status'], readonly OutreachAction[]>> = {
  paused: ['start', 'stop'],
  running: ['pause', 'stop'],
  stopped: [],
};

function CampaignTable({ api, view }: { api: ApiClient; view: OutreachView }) {
  const copy = useCopy();
  const locale = useActiveLocale();
  const [confirming, setConfirming] = useState<{
    campaign: OutreachCampaignView;
    action: OutreachAction;
  } | null>(null);
  const { queryClient, onError } = useStepUpAware();
  const move = useMutation({
    mutationFn: (input: { id: string; action: OutreachAction }) =>
      moveOutreachCampaign(api, input.id, input.action),
    onSuccess: (next) => {
      queryClient.setQueryData(PLATFORM_OUTREACH_QUERY_KEY, next);
      setConfirming(null);
    },
    onError,
  });

  if (view.campaigns.length === 0) {
    return (
      <section className="tm-cc-card tm-stack">
        <h2 className="tm-cc-card__title">{copy('campaigns')}</h2>
        <p className="tm-cc-card__lead">{copy('noCampaigns')}</p>
      </section>
    );
  }
  return (
    <section className="tm-stack tm-stack--tight">
      <h2 className="tm-cc-card__title">{copy('campaigns')}</h2>
      <PlatformTable
        label={copy('campaigns')}
        rows={view.campaigns}
        rowKey={(c) => c.id}
        isMuted={(c) => c.status === 'stopped'}
        columns={[
          { id: 'name', header: copy('colName'), cell: (c) => <bdi>{c.name}</bdi> },
          {
            id: 'status',
            header: copy('colStatus'),
            cell: (c) => <Badge>{copy(`status_${c.status}`)}</Badge>,
          },
          {
            id: 'created',
            header: copy('colCreated'),
            cell: (c) => formatWhen(c.createdAt, locale),
          },
          {
            id: 'queued',
            header: copy('colQueued'),
            kind: 'mono',
            cell: (c) => count(c, 'queued'),
          },
          { id: 'sent', header: copy('colSent'), kind: 'mono', cell: (c) => count(c, 'sent') },
          {
            id: 'failed',
            header: copy('colFailed'),
            kind: 'mono',
            cell: (c) => count(c, 'failed'),
          },
          {
            id: 'suppressed',
            header: copy('colSuppressed'),
            kind: 'mono',
            cell: (c) => count(c, 'suppressed'),
          },
          {
            id: 'bounced',
            header: copy('colBounced'),
            kind: 'mono',
            cell: (c) => count(c, 'bounced'),
          },
          { id: 'trials', header: copy('colTrials'), kind: 'mono', cell: (c) => c.trialsRedeemed },
          {
            id: 'action',
            header: copy('colAction'),
            cell: (c) => (
              <div style={{ display: 'flex', gap: 'var(--s2)' }}>
                {ACTIONS[c.status].map((action) => (
                  <Button
                    key={action}
                    type="button"
                    tone={action === 'start' ? 'lime' : 'outline'}
                    size="compact"
                    disabled={move.isPending}
                    onClick={() =>
                      action === 'pause'
                        ? move.mutate({ id: c.id, action })
                        : setConfirming({ campaign: c, action })
                    }
                  >
                    {copy(action)}
                  </Button>
                ))}
              </div>
            ),
          },
        ]}
      />
      {confirming !== null ? (
        <ConfirmMove
          campaign={confirming.campaign}
          action={confirming.action}
          pending={move.isPending}
          error={move.isError ? move.error : null}
          onConfirm={() => move.mutate({ id: confirming.campaign.id, action: confirming.action })}
          onClose={() => {
            move.reset();
            setConfirming(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ConfirmMove({
  campaign,
  action,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  campaign: OutreachCampaignView;
  action: OutreachAction;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const copy = useCopy();
  const t = useT();
  const stop = action === 'stop';
  return (
    <PlatformDialog
      title={copy(stop ? 'confirmStopTitle' : 'confirmStartTitle', { name: campaign.name })}
      onClose={onClose}
    >
      <p>{copy(stop ? 'confirmStopBody' : 'confirmStartBody')}</p>
      {error !== null ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(error, t)}
        </InlineAlert>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {copy('cancel')}
        </Button>
        <Button
          type="button"
          tone={stop ? 'destructive' : 'lime'}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? copy('working') : copy(action)}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}

function RecipientTable({ api, view }: { api: ApiClient; view: OutreachView }) {
  const copy = useCopy();
  const t = useT();
  const locale = useActiveLocale();
  const { queryClient, onError } = useStepUpAware();
  const bounced = useMutation({
    mutationFn: (id: string) => markOutreachBounced(api, id),
    onSuccess: (next) => queryClient.setQueryData(PLATFORM_OUTREACH_QUERY_KEY, next),
    onError,
  });
  if (view.campaigns.length === 0) return null;
  const status = (r: OutreachRecipientView) =>
    copy((`r_${r.status}` in OUTREACH_COPY ? `r_${r.status}` : 'r_queued') as CopyName);
  return (
    <section className="tm-stack tm-stack--tight">
      <h2 className="tm-cc-card__title">{copy('recipients')}</h2>
      {bounced.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(bounced.error, t)}
        </InlineAlert>
      ) : null}
      {view.recipients.length === 0 ? (
        <p className="tm-cc-card__lead">{copy('noRecipients')}</p>
      ) : (
        <PlatformTable
          label={copy('recipients')}
          rows={view.recipients}
          rowKey={(r) => r.id}
          isMuted={(r) => ['failed', 'suppressed', 'bounced'].includes(r.status)}
          columns={[
            { id: 'company', header: copy('colCompany'), cell: (r) => <bdi>{r.company}</bdi> },
            { id: 'first', header: copy('colFirstName'), cell: (r) => <bdi>{r.firstName}</bdi> },
            { id: 'country', header: copy('colCountry'), kind: 'mono', cell: (r) => r.country },
            { id: 'sender', header: copy('colSender'), cell: (r) => <bdi>{r.sender ?? '—'}</bdi> },
            { id: 'status', header: copy('colRecipientStatus'), cell: status },
            { id: 'sent', header: copy('colSentAt'), cell: (r) => formatWhen(r.sentAt, locale) },
            {
              id: 'trial',
              header: copy('colTrial'),
              cell: (r) => (r.trialRedeemedAt === null ? '—' : copy('trialYes')),
            },
            {
              id: 'action',
              header: copy('colAction'),
              cell: (r) =>
                r.status === 'sent' ? (
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    disabled={bounced.isPending}
                    onClick={() => bounced.mutate(r.id)}
                  >
                    {copy('markBounced')}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </section>
  );
}
