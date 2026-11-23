'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, InlineAlert, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  OUTREACH_LANGUAGES,
  PLATFORM_OUTREACH_QUERY_KEY,
  createOutreachCampaign,
  fetchOutreach,
  importOutreach,
  moveOutreachCampaign,
} from '../../../lib/api/platform-outreach';
import type {
  OutreachAction,
  OutreachCampaignView,
  OutreachExclusion,
  OutreachImportView,
  OutreachLanguage,
  OutreachView,
} from '../../../lib/api/platform-outreach';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate, isStepUpLapse } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { useOutreachCopy } from './outreach-copy';
import { ChipGroup, SettingsSubNav, formatWhen } from './settings-kit';

export { OUTREACH_COPY } from './outreach-copy';

/**
 * LANE-Q + OUTREACH MANAGER · Settings -> Outreach (`/platform/settings/outreach`). The campaign
 * list: active or archived campaigns with their results, a new campaign (name, languages, senders,
 * pace) or a new campaign from the decision-makers CSV, and start, pause or stop. Each campaign
 * opens on its own page (`/platform/settings/outreach/[campaignId]`) for its e-mail and people.
 * The worker sends from each person's own mailbox, at most the campaign's cap a day per mailbox,
 * 09:00-17:00 in the recipient's time zone. No address is shown here.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function PlatformOutreachScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const copy = useOutreachCopy();
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
  const copy = useOutreachCopy();
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
      <CampaignTable api={api} view={view} />
      <ImportCard api={api} />
    </div>
  );
}

export function useStepUpAware() {
  const queryClient = useQueryClient();
  return {
    queryClient,
    onError: (error: unknown) => {
      if (isStepUpLapse(error))
        void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    },
  };
}

/** The language's own name in the reader's language ("Arabic", "العربية"…). */
export function useLanguageName(): (language: string) => string {
  const locale = useActiveLocale();
  return (language) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
    } catch {
      return language;
    }
  };
}

function ImportCard({ api }: { api: ApiClient }) {
  const copy = useOutreachCopy();
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
      <ExclusionList excluded={excluded} />
    </section>
  );
}

export function ExclusionList({ excluded }: { excluded: readonly [OutreachExclusion, number][] }) {
  const copy = useOutreachCopy();
  if (excluded.length === 0) return null;
  return (
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
  );
}

export const campaignCount = (campaign: OutreachCampaignView, status: string) =>
  campaign.counts[status] ?? 0;

export const CAMPAIGN_ACTIONS: Readonly<
  Record<OutreachCampaignView['status'], readonly OutreachAction[]>
> = {
  paused: ['start', 'stop'],
  running: ['pause', 'stop'],
  stopped: [],
};

type Shown = 'active' | 'archived';

function CampaignTable({ api, view }: { api: ApiClient; view: OutreachView }) {
  const copy = useOutreachCopy();
  const t = useT();
  const locale = useActiveLocale();
  const languageName = useLanguageName();
  const [shown, setShown] = useState<Shown>('active');
  const [creating, setCreating] = useState(false);
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
  const rows = view.campaigns.filter((c) =>
    shown === 'active' ? c.archivedAt === null : c.archivedAt !== null,
  );

  return (
    <section className="tm-stack tm-stack--tight">
      <div
        style={{
          display: 'flex',
          gap: 'var(--s3)',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <h2 className="tm-cc-card__title">{copy('campaigns')}</h2>
        <Button type="button" tone="lime" onClick={() => setCreating(true)}>
          {copy('newCampaign')}
        </Button>
      </div>
      <ChipGroup<Shown>
        label={copy('filterLabel')}
        value={shown}
        options={[
          { value: 'active', label: copy('filterActive') },
          { value: 'archived', label: copy('filterArchived') },
        ]}
        onChange={setShown}
      />
      <p className="tm-cc-card__lead">{copy('pace')}</p>
      {rows.length === 0 ? (
        <p className="tm-cc-card__lead">
          {shown === 'active' ? copy('noCampaigns') : copy('noArchived')}
        </p>
      ) : (
        <PlatformTable
          label={copy('campaigns')}
          rows={rows}
          rowKey={(c) => c.id}
          isMuted={(c) => c.status === 'stopped'}
          columns={[
            {
              id: 'name',
              header: copy('colName'),
              cell: (c) => (
                <Link href={`/platform/settings/outreach/${encodeURIComponent(c.id)}`}>
                  <bdi>{c.name}</bdi>
                </Link>
              ),
            },
            {
              id: 'status',
              header: copy('colStatus'),
              cell: (c) => <Badge>{copy(`status_${c.status}`)}</Badge>,
            },
            {
              id: 'languages',
              header: copy('colLanguages'),
              cell: (c) => c.languages.map(languageName).join(', '),
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
              cell: (c) => campaignCount(c, 'queued'),
            },
            {
              id: 'sent',
              header: copy('colSent'),
              kind: 'mono',
              cell: (c) => campaignCount(c, 'sent'),
            },
            {
              id: 'bounced',
              header: copy('colBounced'),
              kind: 'mono',
              cell: (c) => campaignCount(c, 'bounced'),
            },
            {
              id: 'trials',
              header: copy('colTrials'),
              kind: 'mono',
              cell: (c) => c.trialsRedeemed,
            },
            {
              id: 'walkthroughs',
              header: copy('colWalkthroughs'),
              kind: 'mono',
              cell: (c) => c.walkthroughs,
            },
            {
              id: 'action',
              header: copy('colAction'),
              cell: (c) => (
                <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
                  {(c.archivedAt === null ? CAMPAIGN_ACTIONS[c.status] : []).map((action) => (
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
      )}
      {move.isError && confirming === null ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(move.error, t)}
        </InlineAlert>
      ) : null}
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
      {creating ? <NewCampaignDialog api={api} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

export function ConfirmMove({
  campaign,
  action,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  campaign: Pick<OutreachCampaignView, 'name'>;
  action: OutreachAction;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const copy = useOutreachCopy();
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

/** The languages a campaign writes in, as tick boxes (order = the order ticked). */
export function LanguageChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly OutreachLanguage[];
  onChange: (next: OutreachLanguage[]) => void;
  disabled?: boolean;
}) {
  const copy = useOutreachCopy();
  const languageName = useLanguageName();
  return (
    <fieldset className="tm-stack tm-stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="tm-cc-eyebrow">{copy('fieldLanguages')}</legend>
      <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
        {OUTREACH_LANGUAGES.map((language) => (
          <Checkbox
            key={language}
            label={languageName(language)}
            checked={value.includes(language)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, language]
                  : value.filter((item) => item !== language),
              )
            }
          />
        ))}
      </div>
      <span className="tm-cc-note">{copy('languagesHint')}</span>
    </fieldset>
  );
}

function NewCampaignDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const copy = useOutreachCopy();
  const t = useT();
  const router = useRouter();
  const { queryClient, onError } = useStepUpAware();
  const [name, setName] = useState('');
  const [languages, setLanguages] = useState<OutreachLanguage[]>(['en']);
  const [dailyCap, setDailyCap] = useState('20');
  const [warmup, setWarmup] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      createOutreachCampaign(api, {
        name: name.trim(),
        languages,
        dailyCap: Number(dailyCap),
        warmup,
      }),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: PLATFORM_OUTREACH_QUERY_KEY });
      onClose();
      router.push(`/platform/settings/outreach/${encodeURIComponent(detail.campaign.id)}`);
    },
    onError,
  });
  const cap = Number(dailyCap);
  const valid =
    name.trim() !== '' && languages.length > 0 && Number.isInteger(cap) && cap >= 1 && cap <= 20;
  return (
    <PlatformDialog title={copy('newCampaign')} onClose={onClose} width={620}>
      <form
        noValidate
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <p className="tm-cc-card__lead">{copy('newLead')}</p>
        <Field
          label={copy('fieldName')}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        <LanguageChoice value={languages} onChange={setLanguages} />
        <Field
          label={copy('fieldDailyCap')}
          hint={copy('dailyCapHint')}
          type="number"
          min={1}
          max={20}
          inputMode="numeric"
          value={dailyCap}
          onChange={(event) => setDailyCap(event.target.value)}
        />
        <Switch
          label={copy('fieldWarmup')}
          checked={warmup}
          onChange={(event) => setWarmup(event.target.checked)}
        />
        {create.isError ? (
          <InlineAlert tone="danger" live>
            {platformErrorText(create.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {copy('cancel')}
          </Button>
          <Button type="submit" tone="lime" disabled={!valid || create.isPending}>
            {create.isPending ? copy('creating') : copy('create')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
