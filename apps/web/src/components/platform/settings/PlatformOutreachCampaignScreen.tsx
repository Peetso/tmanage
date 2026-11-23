'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  InlineAlert,
  SearchField,
  Select,
  Switch,
} from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_OUTREACH_QUERY_KEY,
  addOutreachRecipient,
  archiveOutreachCampaign,
  duplicateOutreachCampaign,
  exportOutreachRecipients,
  fetchOutreachCampaign,
  fetchOutreachRecipients,
  fetchOutreachVersion,
  importOutreachRecipients,
  markOutreachBounced,
  markOutreachReplied,
  moveOutreachCampaign,
  outreachCampaignKey,
  outreachRecipientsKey,
  previewOutreachEmail,
  removeOutreachRecipient,
  saveOutreachEmail,
  testSendOutreachEmail,
  updateOutreachCampaign,
  updateOutreachRecipient,
} from '../../../lib/api/platform-outreach';
import type {
  OutreachAction,
  OutreachCampaignDetailView,
  OutreachCampaignView,
  OutreachEmailKind,
  OutreachEmailText,
  OutreachExclusion,
  OutreachLanguage,
  OutreachPersonInput,
  OutreachPreviewView,
  OutreachRecipientView,
  OutreachRecipientsView,
  OutreachSenderPool,
} from '../../../lib/api/platform-outreach';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import { OUTREACH_COPY, useOutreachCopy } from './outreach-copy';
import type { OutreachCopyName } from './outreach-copy';
import {
  CAMPAIGN_ACTIONS,
  ConfirmMove,
  ExclusionList,
  LanguageChoice,
  campaignCount,
  useLanguageName,
  useStepUpAware,
} from './PlatformOutreachScreen';
import { ChipGroup, SettingsSubNav, formatWhen } from './settings-kit';

/**
 * OUTREACH MANAGER · one campaign (`/platform/settings/outreach/[campaignId]`), owner 2026-11-23.
 * Overview (results and settings), the first e-mail and the optional follow-up (an editor per
 * language with the placeholders, a live preview exactly as the person gets it, a test to me and
 * the version history), and the recipients (search, filter, add, change, remove, import, export,
 * mark replied or bounced). The rules the editor cannot change are the API's and the worker's
 * (`@tmanage/mail` `renderCampaignEmail`); this page only shows them. No address is ever shown.
 */

type Tab = 'overview' | 'email' | 'followup' | 'recipients';
const TABS: readonly Tab[] = ['overview', 'email', 'followup', 'recipients'];
const TAB_COPY: Readonly<Record<Tab, OutreachCopyName>> = {
  overview: 'tabOverview',
  email: 'tabEmail',
  followup: 'tabFollowup',
  recipients: 'tabRecipients',
};

/** The countries an import can place (`outreach-import.ts` COUNTRIES, the consent ones left out). */
const COUNTRY_CODES = [
  'GB',
  'IE',
  'US',
  'CA',
  'AU',
  'NZ',
  'FI',
  'SE',
  'NL',
  'BE',
  'FR',
  'ES',
  'PT',
  'IT',
  'CH',
  'AT',
  'PL',
  'EE',
  'LV',
  'LT',
  'HR',
  'CZ',
  'EG',
  'AE',
  'SA',
  'QA',
  'KW',
  'BH',
  'OM',
  'JO',
] as const;

const PREVIEW_DELAY_MS = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function PlatformOutreachCampaignScreen({
  client,
  campaignId,
}: ScreenProps & { campaignId: string }) {
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
      {(me) => <CampaignBody api={api} me={me} campaignId={campaignId} />}
    </PlatformGate>
  );
}

function useDetail(api: ApiClient, campaignId: string) {
  return useQuery({
    queryKey: outreachCampaignKey(campaignId),
    queryFn: () => fetchOutreachCampaign(api, campaignId),
    refetchInterval: (query) => (query.state.data?.campaign.status === 'running' ? 60_000 : false),
  });
}

function CampaignBody({
  api,
  me,
  campaignId,
}: {
  api: ApiClient;
  me: PlatformMeView;
  campaignId: string;
}) {
  const copy = useOutreachCopy();
  const detail = useDetail(api, campaignId);
  const [tab, setTab] = useState<Tab>('overview');
  if (detail.isPending) {
    return (
      <>
        <SettingsSubNav active="outreach" />
        <PlatformPageState state="loading" loadingLabel={copy('loading')} />
      </>
    );
  }
  if (detail.isError) {
    const missing = missingPlatformPermission(detail.error);
    return (
      <>
        <SettingsSubNav active="outreach" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState
            state="error"
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        )}
      </>
    );
  }
  const view = detail.data;
  return (
    <div className="tm-stack">
      <SettingsSubNav active="outreach" />
      <CampaignHeader api={api} view={view} />
      {view.campaign.archivedAt !== null ? (
        <InlineAlert tone="neutral">{copy('archivedNote')}</InlineAlert>
      ) : null}
      {view.postalAddressSet ? null : <InlineAlert tone="neutral">{copy('noPostal')}</InlineAlert>}
      <div className="tm-wk-tabs" role="tablist" aria-label={copy('tabsLabel')}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tm-outreach-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`tm-outreach-panel-${id}`}
            onClick={() => setTab(id)}
          >
            {copy(TAB_COPY[id])}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`tm-outreach-panel-${tab}`}
        aria-labelledby={`tm-outreach-tab-${tab}`}
        className="tm-stack"
      >
        {tab === 'overview' ? (
          <>
            <StatsCard campaign={view.campaign} />
            <SettingsCard api={api} view={view} />
          </>
        ) : null}
        {tab === 'email' ? <EmailEditor api={api} view={view} kind="intro" /> : null}
        {tab === 'followup' ? (
          <>
            <FollowupCard api={api} view={view} />
            <EmailEditor api={api} view={view} kind="followup" />
          </>
        ) : null}
        {tab === 'recipients' ? <RecipientsPanel api={api} view={view} /> : null}
      </div>
    </div>
  );
}

const locked = (campaign: OutreachCampaignView) =>
  campaign.archivedAt !== null || campaign.status === 'stopped';

function CampaignHeader({ api, view }: { api: ApiClient; view: OutreachCampaignDetailView }) {
  const copy = useOutreachCopy();
  const t = useT();
  const router = useRouter();
  const { queryClient, onError } = useStepUpAware();
  const campaign = view.campaign;
  const [confirming, setConfirming] = useState<OutreachAction | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: outreachCampaignKey(campaign.id) });
    void queryClient.invalidateQueries({ queryKey: PLATFORM_OUTREACH_QUERY_KEY });
  };
  const move = useMutation({
    mutationFn: (action: OutreachAction) => moveOutreachCampaign(api, campaign.id, action),
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
    onError,
  });
  const duplicate = useMutation({
    mutationFn: () => duplicateOutreachCampaign(api, campaign.id),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: PLATFORM_OUTREACH_QUERY_KEY });
      router.push(`/platform/settings/outreach/${encodeURIComponent(next.campaign.id)}`);
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => archiveOutreachCampaign(api, campaign.id, archived),
    onSuccess: (next) => {
      queryClient.setQueryData(outreachCampaignKey(campaign.id), next);
      void queryClient.invalidateQueries({ queryKey: PLATFORM_OUTREACH_QUERY_KEY });
    },
    onError,
  });
  const error = [duplicate, archive].find((m) => m.isError)?.error;
  const actions = campaign.archivedAt === null ? CAMPAIGN_ACTIONS[campaign.status] : [];
  return (
    <section className="tm-stack tm-stack--tight">
      <Link href="/platform/settings/outreach" className="tm-cc-note">
        {copy('back')}
      </Link>
      <div
        style={{
          display: 'flex',
          gap: 'var(--s3)',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center' }}>
          <h2 className="tm-cc-card__title">
            <bdi>{campaign.name}</bdi>
          </h2>
          <Badge>{copy(`status_${campaign.status}`)}</Badge>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              tone={action === 'start' ? 'lime' : 'outline'}
              disabled={move.isPending}
              onClick={() => (action === 'pause' ? move.mutate(action) : setConfirming(action))}
            >
              {copy(action)}
            </Button>
          ))}
          <Button
            type="button"
            tone="outline"
            disabled={duplicate.isPending}
            onClick={() => duplicate.mutate()}
          >
            {copy('duplicate')}
          </Button>
          {campaign.status !== 'running' ? (
            <Button
              type="button"
              tone="outline"
              disabled={archive.isPending}
              onClick={() => archive.mutate(campaign.archivedAt === null)}
            >
              {campaign.archivedAt === null ? copy('archive') : copy('unarchive')}
            </Button>
          ) : null}
        </div>
      </div>
      {error !== undefined ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(error, t)}
        </InlineAlert>
      ) : null}
      {move.isError && confirming === null ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(move.error, t)}
        </InlineAlert>
      ) : null}
      {confirming !== null ? (
        <ConfirmMove
          campaign={campaign}
          action={confirming}
          pending={move.isPending}
          error={move.isError ? move.error : null}
          onConfirm={() => move.mutate(confirming)}
          onClose={() => {
            move.reset();
            setConfirming(null);
          }}
        />
      ) : null}
    </section>
  );
}

function StatsCard({ campaign }: { campaign: OutreachCampaignView }) {
  const copy = useOutreachCopy();
  const tiles: [OutreachCopyName, number][] = [
    ['stat_queued', campaignCount(campaign, 'queued')],
    ['stat_sent', campaignCount(campaign, 'sent')],
    ['stat_failed', campaignCount(campaign, 'failed')],
    ['stat_bounced', campaignCount(campaign, 'bounced')],
    ['stat_optedOut', campaign.optedOut],
    ['stat_trials', campaign.trialsRedeemed],
    ['stat_walkthroughs', campaign.walkthroughs],
    ['stat_followups', campaign.followupsSent],
    ['stat_replied', campaign.replied],
  ];
  return (
    <section className="tm-cc-card tm-stack">
      <h3 className="tm-cc-card__title">{copy('statsTitle')}</h3>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 'var(--s3)',
          margin: 0,
        }}
      >
        {tiles.map(([label, value]) => (
          <div key={label} className="tm-stack tm-stack--tight">
            <dt className="tm-cc-eyebrow">{copy(label)}</dt>
            <dd className="tm-cc-card__title" style={{ margin: 0 }}>
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SettingsCard({ api, view }: { api: ApiClient; view: OutreachCampaignDetailView }) {
  const copy = useOutreachCopy();
  const t = useT();
  const campaign = view.campaign;
  const { queryClient, onError } = useStepUpAware();
  const [name, setName] = useState(campaign.name);
  const [languages, setLanguages] = useState<OutreachLanguage[]>([...campaign.languages]);
  const [pool, setPool] = useState<OutreachSenderPool>(campaign.senderPool);
  const [chosen, setChosen] = useState<string[]>(
    view.senders.filter((s) => s.chosen).map((s) => s.id),
  );
  const [dailyCap, setDailyCap] = useState(String(campaign.dailyCap));
  const [warmup, setWarmup] = useState(campaign.warmup);
  const save = useMutation({
    mutationFn: () =>
      updateOutreachCampaign(api, campaign.id, {
        name: name.trim(),
        ...(campaign.status === 'stopped'
          ? {}
          : {
              languages,
              senderPool: pool,
              ...(pool === 'chosen' ? { senderIds: chosen } : {}),
              dailyCap: Number(dailyCap),
              warmup,
            }),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(outreachCampaignKey(campaign.id), next);
      void queryClient.invalidateQueries({ queryKey: PLATFORM_OUTREACH_QUERY_KEY });
    },
    onError,
  });
  const archived = campaign.archivedAt !== null;
  const onlyName = campaign.status === 'stopped';
  const cap = Number(dailyCap);
  const valid =
    name.trim() !== '' &&
    languages.length > 0 &&
    Number.isInteger(cap) &&
    cap >= 1 &&
    cap <= 20 &&
    (pool === 'auto' || chosen.length > 0);
  return (
    <section className="tm-cc-card tm-stack">
      <h3 className="tm-cc-card__title">{copy('settingsTitle')}</h3>
      {onlyName ? <p className="tm-cc-note">{copy('settingsStopped')}</p> : null}
      <Field
        label={copy('fieldName')}
        value={name}
        maxLength={120}
        disabled={archived}
        onChange={(event) => setName(event.target.value)}
      />
      <LanguageChoice value={languages} onChange={setLanguages} disabled={archived || onlyName} />
      <ChipGroup<OutreachSenderPool>
        label={copy('fieldSenders')}
        value={pool}
        disabled={archived || onlyName}
        options={[
          { value: 'auto', label: copy('sendersAuto') },
          { value: 'chosen', label: copy('sendersChosen') },
        ]}
        onChange={setPool}
      />
      <span className="tm-cc-note">{copy('sendersHint')}</span>
      {pool === 'chosen' ? (
        <fieldset className="tm-stack tm-stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="tm-cc-eyebrow">{copy('chooseSenders')}</legend>
          {view.senders.map((sender) => (
            <Checkbox
              key={sender.id}
              label={
                <>
                  <bdi>{sender.name}</bdi> · <bdi>{sender.address}</bdi> ·{' '}
                  {copy(sender.side === 'ar' ? 'side_ar' : 'side_en')}
                </>
              }
              checked={chosen.includes(sender.id)}
              disabled={archived || onlyName}
              onChange={(event) =>
                setChosen(
                  event.target.checked
                    ? [...chosen, sender.id]
                    : chosen.filter((id) => id !== sender.id),
                )
              }
            />
          ))}
        </fieldset>
      ) : null}
      <Field
        label={copy('fieldDailyCap')}
        hint={copy('dailyCapHint')}
        type="number"
        min={1}
        max={20}
        inputMode="numeric"
        value={dailyCap}
        disabled={archived || onlyName}
        onChange={(event) => setDailyCap(event.target.value)}
      />
      <Switch
        label={copy('fieldWarmup')}
        checked={warmup}
        disabled={archived || onlyName}
        onChange={(event) => setWarmup(event.target.checked)}
      />
      {save.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(save.error, t)}
        </InlineAlert>
      ) : null}
      {save.isSuccess ? (
        <InlineAlert tone="neutral" live>
          {copy('saved')}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          type="button"
          tone="lime"
          disabled={archived || !valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? copy('saving') : copy('save')}
        </Button>
      </div>
    </section>
  );
}

function FollowupCard({ api, view }: { api: ApiClient; view: OutreachCampaignDetailView }) {
  const copy = useOutreachCopy();
  const t = useT();
  const campaign = view.campaign;
  const { queryClient, onError } = useStepUpAware();
  const [enabled, setEnabled] = useState(campaign.followupEnabled);
  const [days, setDays] = useState(String(campaign.followupDays));
  const save = useMutation({
    mutationFn: () =>
      updateOutreachCampaign(api, campaign.id, {
        followupEnabled: enabled,
        followupDays: Number(days),
      }),
    onSuccess: (next) => queryClient.setQueryData(outreachCampaignKey(campaign.id), next),
    onError,
  });
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 30;
  return (
    <section className="tm-cc-card tm-stack">
      <h3 className="tm-cc-card__title">{copy('tabFollowup')}</h3>
      <p className="tm-cc-card__lead">{copy('followupLead')}</p>
      <Switch
        label={copy('followupSwitch')}
        checked={enabled}
        disabled={locked(campaign)}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      <Field
        label={copy('followupDays')}
        hint={copy('followupDaysHint')}
        type="number"
        min={1}
        max={30}
        inputMode="numeric"
        value={days}
        disabled={locked(campaign)}
        onChange={(event) => setDays(event.target.value)}
      />
      <p className="tm-cc-note">{copy('replyNote')}</p>
      {save.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(save.error, t)}
        </InlineAlert>
      ) : null}
      {save.isSuccess ? (
        <InlineAlert tone="neutral" live>
          {copy('saved')}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          type="button"
          tone="lime"
          disabled={locked(campaign) || !valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? copy('saving') : copy('save')}
        </Button>
      </div>
    </section>
  );
}

type Drafts = Partial<Record<OutreachLanguage, OutreachEmailText>>;

function draftsOf(view: OutreachCampaignDetailView, kind: OutreachEmailKind): Drafts {
  const drafts: Drafts = {};
  for (const language of view.campaign.languages) {
    const saved = view.emails[kind][language];
    drafts[language] = { subject: saved?.subject ?? '', body: saved?.body ?? '' };
  }
  return drafts;
}

function useRecipients(api: ApiClient, campaignId: string) {
  return useQuery({
    queryKey: outreachRecipientsKey(campaignId),
    queryFn: () => fetchOutreachRecipients(api, campaignId),
  });
}

function EmailEditor({
  api,
  view,
  kind,
}: {
  api: ApiClient;
  view: OutreachCampaignDetailView;
  kind: OutreachEmailKind;
}) {
  const copy = useOutreachCopy();
  const t = useT();
  const languageName = useLanguageName();
  const campaign = view.campaign;
  const { queryClient, onError } = useStepUpAware();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(view, kind));
  const [language, setLanguage] = useState<OutreachLanguage>(campaign.languages[0] ?? 'en');
  const [recipientId, setRecipientId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [loaded, setLoaded] = useState<number | null>(null);
  const body = useRef<HTMLTextAreaElement | null>(null);
  const recipients = useRecipients(api, campaign.id);
  const draft = drafts[language] ?? { subject: '', body: '' };
  const saved = view.emails[kind][language];
  const dirty = campaign.languages.some((lang) => {
    const a = drafts[lang];
    const b = view.emails[kind][lang];
    return a?.subject !== (b?.subject ?? '') || a?.body !== (b?.body ?? '');
  });
  const readOnly = locked(campaign);

  const [preview, setPreview] = useState<OutreachPreviewView | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    let live = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      previewOutreachEmail(api, campaign.id, {
        kind,
        language,
        subject: draft.subject,
        body: draft.body,
        ...(recipientId === '' ? {} : { recipientId }),
      })
        .then((next) => {
          if (live) setPreview(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (live) setPreviewing(false);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, campaign.id, kind, language, draft.subject, draft.body, recipientId]);

  const save = useMutation({
    mutationFn: () =>
      saveOutreachEmail(api, campaign.id, kind, {
        texts: drafts,
        ...(campaign.firstStartedAt === null ? {} : { confirmStarted: true }),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(outreachCampaignKey(campaign.id), next);
      setDrafts(draftsOf(next, kind));
      setConfirming(false);
      setLoaded(null);
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () =>
      testSendOutreachEmail(api, campaign.id, {
        kind,
        language,
        subject: draft.subject,
        body: draft.body,
        ...(recipientId === '' ? {} : { recipientId }),
      }),
    onError,
  });
  const loadVersion = useMutation({
    mutationFn: (version: number) => fetchOutreachVersion(api, campaign.id, kind, version),
    onSuccess: (version) => {
      setDrafts((current) => {
        const next: Drafts = { ...current };
        for (const lang of campaign.languages) {
          const text = version.texts[lang];
          if (text !== undefined) next[lang] = text;
        }
        return next;
      });
      setLoaded(version.version);
    },
    onError,
  });

  function setDraft(patch: Partial<OutreachEmailText>) {
    setDrafts((current) => ({ ...current, [language]: { ...draft, ...patch } }));
  }

  function insert(token: string) {
    const area = body.current;
    const at = area?.selectionStart ?? draft.body.length;
    const end = area?.selectionEnd ?? at;
    setDraft({ body: `${draft.body.slice(0, at)}${token}${draft.body.slice(end)}` });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  const problems = preview?.problems ?? [];
  const people = (recipients.data?.recipients ?? []).filter((r) => r.language === language);
  const versions = view.versions.filter((v) => v.kind === kind);
  return (
    <>
      <section className="tm-cc-card tm-stack">
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 className="tm-cc-card__title">
            {copy(kind === 'intro' ? 'kind_intro' : 'kind_followup')}
          </h3>
          <Badge>
            {saved?.version === null || saved === undefined
              ? copy('defaultText')
              : copy('versionBadge', { version: saved.version })}
          </Badge>
          {dirty ? <Badge tone="client">{copy('unsaved')}</Badge> : null}
        </div>
        <p className="tm-cc-card__lead">{copy('editorLead')}</p>
        {readOnly ? <p className="tm-cc-note">{copy('lockedNote')}</p> : null}
        {loaded !== null ? (
          <InlineAlert tone="neutral" live>
            {copy('versionLoaded', { version: loaded })}
          </InlineAlert>
        ) : null}
        {campaign.languages.length > 1 ? (
          <ChipGroup<OutreachLanguage>
            label={copy('languageLabel')}
            value={language}
            options={campaign.languages.map((lang) => ({ value: lang, label: languageName(lang) }))}
            onChange={setLanguage}
          />
        ) : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 'var(--s5)',
            alignItems: 'start',
          }}
        >
          <div className="tm-stack" dir={language === 'ar' || language === 'ur' ? 'rtl' : 'ltr'}>
            <Field
              label={copy('fieldSubject')}
              value={draft.subject}
              maxLength={150}
              disabled={readOnly}
              onChange={(event) => setDraft({ subject: event.target.value })}
            />
            <div className="tm-stack tm-stack--tight">
              <span className="tm-cc-eyebrow">{copy('insertLabel')}</span>
              <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
                {view.placeholders.map((token) => (
                  <Button
                    key={token}
                    type="button"
                    tone="outline"
                    size="compact"
                    disabled={readOnly}
                    onClick={() => insert(token)}
                  >
                    <bdi>{token}</bdi>
                  </Button>
                ))}
              </div>
            </div>
            <label className="tm-content-textarea">
              <span className="tm-content-textarea__label">{copy('fieldBody')}</span>
              <textarea
                ref={body}
                value={draft.body}
                rows={16}
                maxLength={10_000}
                disabled={readOnly}
                aria-invalid={problems.some(
                  (p) => p.startsWith('body') || p.endsWith('placeholder'),
                )}
                onChange={(event) => setDraft({ body: event.target.value })}
              />
            </label>
            {problems.length > 0 ? (
              <InlineAlert tone="danger" live>
                <ul>
                  {problems.map((problem) => (
                    <li key={problem}>{problemText(copy, problem)}</li>
                  ))}
                </ul>
              </InlineAlert>
            ) : null}
            {save.isError ? (
              <InlineAlert tone="danger" live>
                {platformErrorText(save.error, t)}
              </InlineAlert>
            ) : null}
            <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
              <Button
                type="button"
                tone="lime"
                disabled={readOnly || !dirty || problems.length > 0 || save.isPending}
                onClick={() =>
                  campaign.firstStartedAt === null ? save.mutate() : setConfirming(true)
                }
              >
                {save.isPending ? copy('saving') : copy('saveVersion')}
              </Button>
              <Button
                type="button"
                tone="outline"
                disabled={problems.length > 0 || test.isPending}
                onClick={() => test.mutate()}
              >
                {test.isPending ? copy('testSending') : copy('testSend')}
              </Button>
            </div>
            {test.isSuccess ? (
              <InlineAlert tone={test.data.sent ? 'neutral' : 'danger'} live>
                {test.data.sent ? copy('testSent', { address: test.data.to }) : copy('testNotSent')}
              </InlineAlert>
            ) : null}
            {test.isError ? (
              <InlineAlert tone="danger" live>
                {platformErrorText(test.error, t)}
              </InlineAlert>
            ) : null}
          </div>
          <PreviewPane
            preview={preview}
            previewing={previewing}
            language={language}
            recipientId={recipientId}
            people={people}
            onRecipient={setRecipientId}
          />
        </div>
      </section>
      <VersionsCard
        versions={versions}
        pending={loadVersion.isPending}
        onLoad={(version) => loadVersion.mutate(version)}
      />
      {confirming ? (
        <PlatformDialog title={copy('confirmSaveTitle')} onClose={() => setConfirming(false)}>
          <p>{copy('confirmSaveBody')}</p>
          {save.isError ? (
            <InlineAlert tone="danger" live>
              {platformErrorText(save.error, t)}
            </InlineAlert>
          ) : null}
          <PlatformDialogActions>
            <Button type="button" tone="outline" onClick={() => setConfirming(false)}>
              {copy('cancel')}
            </Button>
            <Button
              type="button"
              tone="lime"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? copy('saving') : copy('confirmSave')}
            </Button>
          </PlatformDialogActions>
        </PlatformDialog>
      ) : null}
    </>
  );
}

function problemText(copy: ReturnType<typeof useOutreachCopy>, problem: string): string {
  const name = `p_${problem}`;
  return name in OUTREACH_COPY ? copy(name as OutreachCopyName) : problem;
}

function PreviewPane({
  preview,
  previewing,
  language,
  recipientId,
  people,
  onRecipient,
}: {
  preview: OutreachPreviewView | null;
  previewing: boolean;
  language: OutreachLanguage;
  recipientId: string;
  people: readonly OutreachRecipientView[];
  onRecipient: (id: string) => void;
}) {
  const copy = useOutreachCopy();
  const rtl = language === 'ar' || language === 'ur';
  return (
    <div className="tm-stack" aria-live="polite" aria-busy={previewing}>
      <h4 className="tm-cc-eyebrow">{copy('previewTitle')}</h4>
      <Select
        label={copy('previewFor')}
        value={recipientId}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onRecipient(event.target.value)}
      >
        <option value="">{copy('sampleOne')}</option>
        {people.slice(0, 200).map((person) => (
          <option key={person.id} value={person.id}>
            {person.firstName} · {person.company}
          </option>
        ))}
      </Select>
      <div className="tm-cc-card tm-stack tm-stack--tight" dir={rtl ? 'rtl' : 'ltr'}>
        <p className="tm-cc-note">
          {copy('previewFrom')}: <bdi>{preview?.from ?? '—'}</bdi>
        </p>
        <p className="tm-cc-note">
          {copy('previewTo')}: <bdi>{preview?.to ?? '—'}</bdi>
        </p>
        <p>
          <strong>
            {copy('previewSubject')}: <bdi>{preview?.subject ?? ''}</bdi>
          </strong>
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
          {preview?.text ?? ''}
        </pre>
      </div>
      <span className="tm-cc-note">
        {previewing ? copy('previewLoading') : copy('previewNote')}
      </span>
    </div>
  );
}

function VersionsCard({
  versions,
  pending,
  onLoad,
}: {
  versions: OutreachCampaignDetailView['versions'];
  pending: boolean;
  onLoad: (version: number) => void;
}) {
  const copy = useOutreachCopy();
  const locale = useActiveLocale();
  const languageName = useLanguageName();
  return (
    <section className="tm-cc-card tm-stack">
      <h3 className="tm-cc-card__title">{copy('versionsTitle')}</h3>
      <p className="tm-cc-card__lead">{copy('versionsLead')}</p>
      {versions.length === 0 ? (
        <p className="tm-cc-note">{copy('noVersions')}</p>
      ) : (
        <PlatformTable
          label={copy('versionsTitle')}
          rows={versions}
          rowKey={(v) => `${v.kind}-${String(v.version)}`}
          columns={[
            { id: 'version', header: copy('colVersion'), kind: 'mono', cell: (v) => v.version },
            {
              id: 'languages',
              header: copy('colLanguages'),
              cell: (v) => v.languages.map(languageName).join(', '),
            },
            { id: 'saved', header: copy('colSaved'), cell: (v) => formatWhen(v.createdAt, locale) },
            { id: 'by', header: copy('colBy'), cell: (v) => copy(v.byYou ? 'byYou' : 'byOther') },
            {
              id: 'action',
              header: copy('colAction'),
              cell: (v) => (
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  disabled={pending}
                  onClick={() => onLoad(v.version)}
                >
                  {copy('viewVersion')}
                </Button>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}

type StatusFilter = 'all' | 'queued' | 'sent' | 'failed' | 'bounced' | 'suppressed';
const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'queued',
  'sent',
  'failed',
  'bounced',
  'suppressed',
];

function RecipientsPanel({ api, view }: { api: ApiClient; view: OutreachCampaignDetailView }) {
  const copy = useOutreachCopy();
  const t = useT();
  const locale = useActiveLocale();
  const languageName = useLanguageName();
  const campaign = view.campaign;
  const recipients = useRecipients(api, campaign.id);
  const { queryClient, onError } = useStepUpAware();
  const file = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<OutreachRecipientView | 'new' | null>(null);
  const [removing, setRemoving] = useState<OutreachRecipientView | null>(null);
  const [imported, setImported] = useState<{
    imported: number;
    rows: number;
    excluded: [OutreachExclusion, number][];
  } | null>(null);
  const settle = (next: OutreachRecipientsView) => {
    queryClient.setQueryData(outreachRecipientsKey(campaign.id), next);
    void queryClient.invalidateQueries({ queryKey: outreachCampaignKey(campaign.id) });
  };
  const replied = useMutation({
    mutationFn: (id: string) => markOutreachReplied(api, id),
    onSuccess: settle,
    onError,
  });
  const bounced = useMutation({
    mutationFn: (id: string) => markOutreachBounced(api, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: outreachRecipientsKey(campaign.id) });
      void queryClient.invalidateQueries({ queryKey: outreachCampaignKey(campaign.id) });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeOutreachRecipient(api, id),
    onSuccess: (next) => {
      settle(next);
      setRemoving(null);
    },
    onError,
  });
  const importCsv = useMutation({
    mutationFn: (csv: string) => importOutreachRecipients(api, campaign.id, csv),
    onSuccess: (next) => {
      settle(next);
      setImported({
        imported: next.imported,
        rows: next.rows,
        excluded: Object.entries(next.excluded) as [OutreachExclusion, number][],
      });
    },
    onError,
  });
  const exportCsv = useMutation({
    mutationFn: () => exportOutreachRecipients(api, campaign.id),
    onSuccess: (file) => {
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    },
    onError,
  });

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    setImported(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined || file.size > MAX_FILE_BYTES) return;
    void file.text().then((csv) => importCsv.mutate(csv));
  }

  const all = useMemo(() => recipients.data?.recipients ?? [], [recipients.data]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        (needle === '' ||
          r.company.toLowerCase().includes(needle) ||
          r.personName.toLowerCase().includes(needle)),
    );
  }, [all, query, status]);
  const errors = [replied, bounced, remove, importCsv, exportCsv].filter((m) => m.isError);
  const statusText = (r: OutreachRecipientView) =>
    copy((`r_${r.status}` in OUTREACH_COPY ? `r_${r.status}` : 'r_queued') as OutreachCopyName);
  const followupText = (r: OutreachRecipientView) =>
    r.followupStatus === null
      ? '—'
      : `f_${r.followupStatus}` in OUTREACH_COPY
        ? copy(`f_${r.followupStatus}` as OutreachCopyName)
        : r.followupStatus;
  const writable = !locked(campaign);

  return (
    <section className="tm-stack">
      <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
        <Button type="button" tone="lime" disabled={!writable} onClick={() => setEditing('new')}>
          {copy('addPerson')}
        </Button>
        <Button
          type="button"
          tone="outline"
          disabled={!writable || importCsv.isPending}
          onClick={() => file.current?.click()}
        >
          {importCsv.isPending ? copy('importing') : copy('importMore')}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label={copy('importFile')}
          onChange={pickFile}
        />
        <Button
          type="button"
          tone="outline"
          disabled={exportCsv.isPending || all.length === 0}
          onClick={() => exportCsv.mutate()}
        >
          {exportCsv.isPending ? copy('exporting') : copy('exportCsv')}
        </Button>
      </div>
      <span className="tm-cc-note">{copy('csvHint')}</span>
      {imported !== null ? (
        <InlineAlert tone="neutral" live>
          {copy('importedInto', { imported: imported.imported, rows: imported.rows })}
        </InlineAlert>
      ) : null}
      {imported !== null ? <ExclusionList excluded={imported.excluded} /> : null}
      {errors.map((m, index) => (
        <InlineAlert key={index} tone="danger" live>
          {platformErrorText(m.error, t)}
        </InlineAlert>
      ))}
      <SearchField
        label={copy('searchLabel')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ChipGroup<StatusFilter>
        label={copy('statusFilter')}
        value={status}
        options={STATUS_FILTERS.map((value) => ({
          value,
          label: value === 'all' ? copy('filterAll') : copy(`r_${value}` as OutreachCopyName),
        }))}
        onChange={setStatus}
      />
      <span className="tm-cc-note">
        {copy('shownCount', { shown: shown.length, total: all.length })}
      </span>
      {recipients.isPending ? (
        <PlatformPageState state="loading" loadingLabel={copy('loading')} />
      ) : all.length === 0 ? (
        <p className="tm-cc-card__lead">{copy('noRecipients')}</p>
      ) : shown.length === 0 ? (
        <p className="tm-cc-card__lead">{copy('noMatch')}</p>
      ) : (
        <PlatformTable
          label={copy('tabRecipients')}
          rows={shown}
          rowKey={(r) => r.id}
          isMuted={(r) => ['failed', 'suppressed', 'bounced'].includes(r.status) || r.optedOut}
          columns={[
            { id: 'company', header: copy('colCompany'), cell: (r) => <bdi>{r.company}</bdi> },
            { id: 'person', header: copy('colPerson'), cell: (r) => <bdi>{r.personName}</bdi> },
            { id: 'country', header: copy('colCountry'), kind: 'mono', cell: (r) => r.country },
            {
              id: 'language',
              header: copy('colLanguage'),
              cell: (r) => languageName(r.language),
            },
            { id: 'sender', header: copy('colSender'), cell: (r) => <bdi>{r.sender ?? '—'}</bdi> },
            {
              id: 'status',
              header: copy('colRecipientStatus'),
              cell: (r) => (
                <>
                  {statusText(r)}
                  {r.optedOut ? (
                    <>
                      {' '}
                      <Badge>{copy('optedOutBadge')}</Badge>
                    </>
                  ) : null}
                </>
              ),
            },
            { id: 'sent', header: copy('colSentAt'), cell: (r) => formatWhen(r.sentAt, locale) },
            { id: 'followup', header: copy('colFollowup'), cell: followupText },
            {
              id: 'replied',
              header: copy('colReplied'),
              cell: (r) => (r.repliedAt === null ? '—' : copy('yes')),
            },
            {
              id: 'trial',
              header: copy('colTrial'),
              cell: (r) => (r.trialRedeemedAt === null ? '—' : copy('trialYes')),
            },
            {
              id: 'walkthrough',
              header: copy('colWalkthrough'),
              cell: (r) => (r.walkthroughAt === null ? '—' : copy('yes')),
            },
            {
              id: 'action',
              header: copy('colAction'),
              cell: (r) => (
                <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
                  {r.status === 'queued' && writable ? (
                    <>
                      <Button
                        type="button"
                        tone="outline"
                        size="compact"
                        onClick={() => setEditing(r)}
                      >
                        {copy('edit')}
                      </Button>
                      <Button
                        type="button"
                        tone="outline"
                        size="compact"
                        onClick={() => setRemoving(r)}
                      >
                        {copy('remove')}
                      </Button>
                    </>
                  ) : null}
                  {r.status === 'sent' && r.repliedAt === null ? (
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      disabled={replied.isPending}
                      onClick={() => replied.mutate(r.id)}
                    >
                      {copy('markReplied')}
                    </Button>
                  ) : null}
                  {r.status === 'sent' ? (
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      disabled={bounced.isPending}
                      onClick={() => bounced.mutate(r.id)}
                    >
                      {copy('markBounced')}
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      )}
      {editing !== null ? (
        <PersonDialog
          api={api}
          view={view}
          person={editing === 'new' ? null : editing}
          onDone={(next) => {
            settle(next);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {removing !== null ? (
        <PlatformDialog
          title={copy('removeTitle', { name: removing.personName })}
          onClose={() => setRemoving(null)}
        >
          <p>{copy('removeBody')}</p>
          {remove.isError ? (
            <InlineAlert tone="danger" live>
              {platformErrorText(remove.error, t)}
            </InlineAlert>
          ) : null}
          <PlatformDialogActions>
            <Button type="button" tone="outline" onClick={() => setRemoving(null)}>
              {copy('cancel')}
            </Button>
            <Button
              type="button"
              tone="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(removing.id)}
            >
              {remove.isPending ? copy('working') : copy('remove')}
            </Button>
          </PlatformDialogActions>
        </PlatformDialog>
      ) : null}
    </section>
  );
}

function PersonDialog({
  api,
  view,
  person,
  onDone,
  onClose,
}: {
  api: ApiClient;
  view: OutreachCampaignDetailView;
  person: OutreachRecipientView | null;
  onDone: (next: OutreachRecipientsView) => void;
  onClose: () => void;
}) {
  const copy = useOutreachCopy();
  const t = useT();
  const locale = useActiveLocale();
  const languageName = useLanguageName();
  const { onError } = useStepUpAware();
  const campaign = view.campaign;
  const [company, setCompany] = useState(person?.company ?? '');
  const [firstName, setFirstName] = useState(person?.personName ?? '');
  const [country, setCountry] = useState(person?.country ?? 'GB');
  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState<OutreachLanguage>(
    (person?.language as OutreachLanguage | undefined) ?? campaign.languages[0] ?? 'en',
  );
  const regionName = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const save = useMutation({
    mutationFn: () => {
      const input: OutreachPersonInput = {
        company: company.trim(),
        firstName: firstName.trim(),
        country,
        email: email.trim(),
        language,
      };
      return person === null
        ? addOutreachRecipient(api, campaign.id, input)
        : updateOutreachRecipient(api, person.id, input);
    },
    onSuccess: onDone,
    onError,
  });
  const valid =
    company.trim() !== '' && firstName.trim() !== '' && (person !== null || email.trim() !== '');
  const reason = excludedReason(save.error);
  return (
    <PlatformDialog
      title={person === null ? copy('addPerson') : copy('editTitle', { name: person.personName })}
      onClose={onClose}
      width={560}
    >
      <form
        noValidate
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <p className="tm-cc-card__lead">{copy('addRules')}</p>
        <Field
          label={copy('fieldCompany')}
          value={company}
          maxLength={160}
          onChange={(event) => setCompany(event.target.value)}
        />
        <Field
          label={copy('fieldFirstName')}
          value={firstName}
          maxLength={120}
          onChange={(event) => setFirstName(event.target.value)}
        />
        <Select
          label={copy('fieldCountry')}
          value={country}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => setCountry(event.target.value)}
        >
          {COUNTRY_CODES.map((code) => (
            <option key={code} value={code}>
              {regionName(code)}
            </option>
          ))}
        </Select>
        <Field
          label={copy('fieldEmail')}
          type="email"
          autoComplete="off"
          value={email}
          maxLength={254}
          {...(person === null ? {} : { hint: copy('emailKeepHint') })}
          onChange={(event) => setEmail(event.target.value)}
        />
        {campaign.languages.length > 1 ? (
          <Select
            label={copy('fieldLanguage')}
            value={language}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setLanguage(event.target.value as OutreachLanguage)
            }
          >
            {campaign.languages.map((lang) => (
              <option key={lang} value={lang}>
                {languageName(lang)}
              </option>
            ))}
          </Select>
        ) : null}
        {save.isError ? (
          <InlineAlert tone="danger" live>
            {reason !== null
              ? copy('excludedReason', { reason: copy(`x_${reason}`) })
              : platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {copy('cancel')}
          </Button>
          <Button type="submit" tone="lime" disabled={!valid || save.isPending}>
            {save.isPending ? copy('working') : person === null ? copy('add') : copy('saveChanges')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}

const EXCLUSIONS: readonly OutreachExclusion[] = [
  'consent_country',
  'us_without_postal_address',
  'unknown_country',
  'no_name',
  'bad_email',
  'flagged',
  'contact_type',
  'duplicate_address',
  'second_at_company',
  'suppressed',
];

/** The import rule a refused person broke (the API names it in the error's details). */
function excludedReason(error: unknown): OutreachExclusion | null {
  const details = (error as { details?: readonly { field?: string; message?: string }[] } | null)
    ?.details;
  const found = details?.find((d) => d.field === 'person')?.message;
  return EXCLUSIONS.find((reason) => reason === found) ?? null;
}
