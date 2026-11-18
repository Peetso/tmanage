'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Field,
  InlineAlert,
  Select,
  StatusDot,
  Switch,
  Tooltip,
  VisuallyHidden,
} from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { setPlatformAiAccess, setPlatformPublicSignup } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_INTEGRATIONS_QUERY_KEY,
  PLATFORM_SETTINGS_QUERY_KEY,
  fetchPlatformIntegrations,
  fetchPlatformSettingsFull,
  setPlatformBetaBanner,
  setPlatformBillingMode,
  setPlatformIntegration,
  setPlatformRetention,
  setPlatformSupportDefaults,
} from '../../../lib/api/platform-settings';
import type {
  PlatformBillingMode,
  PlatformIntegrationKey,
  PlatformIntegrationView,
  PlatformSettingsFullView,
} from '../../../lib/api/platform-settings';
import type { MessageKey } from '../../../lib/i18n/t';
import { formatWholeDuration } from '../../../lib/i18n/duration';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  REASON_MIN,
  ReasonDialog,
  platformErrorText,
} from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { FeatureNewsCard } from './FeatureNewsCard';
import { MailPeopleCard } from './MailPeopleCard';
import { SettingsSubNav, changedLine, fill } from './settings-kit';

/**
 * D1 · Platform settings — General (`/platform/settings`, frames 434:15722, 435:14933 billing
 * confirm, 435:15177 error, 435:15341 step-up + 403). Two columns of cards — Sign-up, AI access,
 * Billing mode, Retention, Beta banner, Support sessions — then the Integrations table. Server values
 * in Hostinger are the defaults; a save here overrides them and is audited with the admin's name.
 */
export function PlatformGeneralSettingsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), t('PlatformSettings.navGeneral')]}
      title={t('PlatformSettings.title')}
      description={t('PlatformSettings.description')}
      actions={() => (
        <Link href="/platform/audit" className="tm-button tm-button--outline tm-button--default">
          {t('PlatformSettings.viewChangeLog')}
        </Link>
      )}
    >
      {(me) => <GeneralBody api={api} me={me} />}
    </PlatformGate>
  );
}

function GeneralBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const settings = useQuery({
    queryKey: PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: () => fetchPlatformSettingsFull(api),
  });
  const canEdit = me.permissions.includes('platform.settings.edit');

  if (settings.isPending) {
    return (
      <>
        <SettingsSubNav active="general" />
        <PlatformPageState state="loading" loadingLabel={t('PlatformSettings.loading')} />
      </>
    );
  }
  if (settings.isError) {
    const missing = missingPlatformPermission(settings.error);
    return (
      <>
        <SettingsSubNav active="general" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState
            state="error"
            error={settings.error}
            title={t('PlatformSettings.loadErrorTitle')}
            onRetry={() => void settings.refetch()}
          />
        )}
      </>
    );
  }
  const view = settings.data;
  return (
    <div className="tm-stack">
      <SettingsSubNav active="general" />
      {!canEdit ? (
        <InlineAlert tone="neutral">
          {t('PlatformSettings.readOnlyNote')} <bdi dir="ltr">platform.settings.edit</bdi>
        </InlineAlert>
      ) : null}
      <div className="tm-cc-split tm-cc-split--even">
        <div className="tm-cc-column tm-stack">
          <SignupCard api={api} view={view} canEdit={canEdit} />
          <BillingCard api={api} view={view} canEdit={canEdit} me={me} />
          <BetaBannerCard api={api} view={view} canEdit={canEdit} />
        </div>
        <div className="tm-cc-column tm-stack">
          <AiAccessCard api={api} view={view} canEdit={canEdit} />
          <RetentionCard api={api} view={view} canEdit={canEdit} />
          <SupportCard api={api} view={view} canEdit={canEdit} />
        </div>
      </div>
      <IntegrationsSection api={api} canEdit={canEdit} />
      <MailPeopleCard api={api} canEdit={canEdit} />
      <FeatureNewsCard api={api} canEdit={canEdit} />
      <p className="tm-cc-cell-sub">{t('PlatformSettings.footerAudit')}</p>
    </div>
  );
}

/** After any write: re-read the settings (and the `me` query when the step-up lapsed). */
function useRefresh() {
  const queryClient = useQueryClient();
  return async (error?: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    }
    await queryClient.invalidateQueries({ queryKey: PLATFORM_SETTINGS_QUERY_KEY });
  };
}

interface CardProps {
  api: ApiClient;
  view: PlatformSettingsFullView;
  canEdit: boolean;
}

// ── Sign-up ─────────────────────────────────────────────────────────────────

function SignupCard({ api, view, canEdit }: CardProps) {
  const t = useT();
  const locale = useActiveLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const signup = view.publicSignup;
  const changed = changedLine(view.changes.publicSignup, locale, t);
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="tm-ps-signup">
      <h2 id="tm-ps-signup" className="tm-cc-card__title">
        {t('PlatformSettings.signupTitle')}
      </h2>
      <div className="tm-cc-card__head">
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{t('PlatformSettings.signupLabel')}</span>
          <span className="tm-cc-note">{t('PlatformSettings.signupBody')}</span>
        </div>
        <Switch
          label={<VisuallyHidden>{t('PlatformSettings.signupLabel')}</VisuallyHidden>}
          checked={signup.open}
          disabled={!canEdit}
          onChange={() => setConfirming(true)}
        />
      </div>
      <p className="tm-cc-cell-sub">
        {fill(t('PlatformSettings.signupServerDefault'), {
          value: signup.environmentDefault
            ? t('PlatformSettings.valueOpen')
            : t('PlatformSettings.valueClosed'),
        })}
        {changed ? ` · ${changed}` : ''}
      </p>
      {confirming ? (
        <ReasonDialog
          title={
            signup.open
              ? t('PlatformSettings.signupCloseTitle')
              : t('PlatformSettings.signupOpenTitle')
          }
          reasonRequired
          destructive={signup.open}
          confirmLabel={
            signup.open
              ? t('PlatformSettings.signupCloseConfirm')
              : t('PlatformSettings.signupOpenConfirm')
          }
          onConfirm={async (reason) => {
            await setPlatformPublicSignup(api, !signup.open, reason ?? '');
          }}
          onClose={(done) => {
            setConfirming(false);
            if (done) void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

// ── AI access (anchor #ai-access; `/platform/ai-access` redirects here) ─────

function AiAccessCard({ api, view, canEdit }: CardProps) {
  const t = useT();
  const locale = useActiveLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const { on, environmentDisabled } = view.aiAccess;
  const changed = changedLine(view.changes.aiAccess, locale, t);
  return (
    <section
      id="ai-access"
      className="tm-cc-card tm-cc-card--ink tm-cc-hero"
      aria-labelledby="tm-ps-ai"
      style={{ scrollMarginBlockStart: 'var(--s6)' }}
    >
      <div className="tm-stack tm-stack--tight">
        <p className="tm-cc-eyebrow">{t('PlatformSettings.aiEyebrow')}</p>
        <h2 id="tm-ps-ai" className="tm-cc-card__lead">
          {t('PlatformSettings.aiTitle')}
        </h2>
        <p className="tm-cc-card__body">
          {environmentDisabled ? t('PlatformSettings.aiLocked') : t('PlatformSettings.aiBody')}
        </p>
        {changed ? (
          <p className="tm-cc-card__body" data-testid="ai-access-last-change">
            {changed} ·{' '}
            {on ? t('PlatformSettings.turnedOnLower') : t('PlatformSettings.turnedOffLower')}
          </p>
        ) : null}
      </div>
      <Switch
        label={<VisuallyHidden>{t('PlatformSettings.aiTitle')}</VisuallyHidden>}
        checked={on && !environmentDisabled}
        disabled={environmentDisabled || !canEdit}
        onChange={() => setConfirming(true)}
      />
      {confirming ? (
        <ReasonDialog
          title={on ? t('PlatformSettings.aiOffTitle') : t('PlatformSettings.aiOnTitle')}
          body={on ? t('PlatformSettings.aiOffBody') : t('PlatformSettings.aiOnBody')}
          reasonRequired
          destructive={on}
          confirmLabel={on ? t('PlatformSettings.aiOffConfirm') : t('PlatformSettings.aiOnConfirm')}
          onConfirm={async (reason) => {
            await setPlatformAiAccess(api, !on, reason ?? '');
          }}
          onClose={(done) => {
            setConfirming(false);
            if (done) void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

// ── Billing mode ────────────────────────────────────────────────────────────

const TILE = {
  display: 'grid',
  gap: 'var(--s2)',
  textAlign: 'start' as const,
  padding: 'var(--s4)',
  borderRadius: 'var(--radius-m, 12px)',
  border: '1px solid var(--tm-border, currentColor)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

function BillingCard({ api, view, canEdit, me }: CardProps & { me: PlatformMeView }) {
  const t = useT();
  const refresh = useRefresh();
  const [target, setTarget] = useState<PlatformBillingMode | null>(null);
  const billing = view.billingMode;
  const tiles: readonly { mode: PlatformBillingMode; title: MessageKey; body: MessageKey }[] = [
    {
      mode: 'beta_free',
      title: 'PlatformSettings.billingBeta',
      body: 'PlatformSettings.billingBetaBody',
    },
    {
      mode: 'paid',
      title: 'PlatformSettings.billingPaid',
      body: 'PlatformSettings.billingPaidBody',
    },
  ];
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="tm-ps-billing">
      <h2 id="tm-ps-billing" className="tm-cc-card__title">
        {t('PlatformSettings.billingTitle')}
      </h2>
      <p className="tm-cc-note">{t('PlatformSettings.billingBody')}</p>
      <div
        role="radiogroup"
        aria-labelledby="tm-ps-billing"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 'var(--s3)',
        }}
      >
        {tiles.map((tile) => {
          const current = billing.mode === tile.mode;
          return (
            <button
              key={tile.mode}
              type="button"
              role="radio"
              aria-checked={current}
              disabled={!canEdit}
              style={{
                ...TILE,
                ...(current
                  ? { background: 'var(--lime-100, #eefcd5)', borderColor: 'var(--ink-900, #000)' }
                  : {}),
              }}
              onClick={() => {
                if (!current) setTarget(tile.mode);
              }}
            >
              <span className="tm-cc-cell-title">
                {t(tile.title)}{' '}
                {current ? (
                  <span className="tm-cc-pill tm-cc-pill--muted">
                    {t('PlatformSettings.current')}
                  </span>
                ) : null}
              </span>
              <span className="tm-cc-cell-sub">{t(tile.body)}</span>
            </button>
          );
        })}
      </div>
      <InlineAlert tone="warning">
        {fill(t('PlatformSettings.billingAffects'), { count: billing.organizationCount })}
      </InlineAlert>
      <p className="tm-cc-cell-sub">
        {fill(t('PlatformSettings.billingServerDefault'), { value: billing.environmentDefault })}
        {billing.overrideCount !== null
          ? ` · ${fill(t('PlatformSettings.billingOverrides'), { count: billing.overrideCount })}`
          : ''}
      </p>
      {target !== null ? (
        <BillingConfirmDialog
          api={api}
          target={target}
          view={view}
          me={me}
          onClose={(done) => {
            setTarget(null);
            if (done) void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/** Frame 435:14933 — "Switch billing mode to Paid?" with the organization counts and a reason. */
function BillingConfirmDialog({
  api,
  target,
  view,
  me,
  onClose,
}: {
  api: ApiClient;
  target: PlatformBillingMode;
  view: PlatformSettingsFullView;
  me: PlatformMeView;
  onClose: (done: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = reason.trim();
  const invalid = trimmed.length < REASON_MIN || trimmed.length > REASON_MAX;
  const overrides = view.billingMode.overrideCount ?? 0;
  const moving = Math.max(0, view.billingMode.organizationCount - overrides);
  const minutesAgo =
    me.stepUpExpiresAt === null
      ? null
      : Math.max(
          0,
          Math.round(
            (Date.now() - (new Date(me.stepUpExpiresAt).getTime() - me.stepUpMinutes * 60_000)) /
              60_000,
          ),
        );
  const save = useMutation({
    mutationFn: () => setPlatformBillingMode(api, target, trimmed),
    onSuccess: () => onClose(true),
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });
  const paid = target === 'paid';
  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!invalid) save.mutate();
  }
  return (
    <PlatformDialog
      eyebrow={t('PlatformSettings.billingDialogEyebrow')}
      title={
        paid ? t('PlatformSettings.billingToPaidTitle') : t('PlatformSettings.billingToBetaTitle')
      }
      onClose={() => onClose(false)}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <p className="tm-cc-note">
          {paid ? t('PlatformSettings.billingToPaidBody') : t('PlatformSettings.billingToBetaBody')}
        </p>
        <ul className="tm-cc-rows">
          <li>
            <span className="tm-cc-cell-title">
              {fill(
                paid
                  ? t('PlatformSettings.billingMoveToPaid')
                  : t('PlatformSettings.billingMoveToBeta'),
                { count: moving },
              )}
            </span>
          </li>
          <li>
            <span className="tm-cc-cell-title">
              {fill(t('PlatformSettings.billingKeepOverride'), { count: overrides })}
            </span>
          </li>
        </ul>
        <Field
          label={t('PlatformSettings.reasonRequiredLabel')}
          hint={t('PlatformSettings.reasonAuditHint')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={REASON_MAX}
          required
          {...(tried && invalid ? { error: t('PlatformShared.reasonError') } : {})}
        />
        {minutesAgo !== null ? (
          <InlineAlert tone="neutral">
            {fill(t('PlatformSettings.stepUpLive'), { minutes: minutesAgo })}
          </InlineAlert>
        ) : null}
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={() => onClose(false)}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone={paid ? 'destructive' : 'ink'}
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {paid
              ? t('PlatformSettings.billingToPaidConfirm')
              : t('PlatformSettings.billingToBetaConfirm')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}

// ── Retention ───────────────────────────────────────────────────────────────

function asDays(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : null;
}

function RetentionCard({ api, view, canEdit }: CardProps) {
  const t = useT();
  const refresh = useRefresh();
  const [org, setOrg] = useState(String(view.retention.orgPurgeDays));
  const [user, setUser] = useState(String(view.retention.userPurgeDays));
  const [content, setContent] = useState(String(view.retention.contentPurgeDays));
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setOrg(String(view.retention.orgPurgeDays));
    setUser(String(view.retention.userPurgeDays));
    setContent(String(view.retention.contentPurgeDays));
  }, [view.retention]);
  const values = { org: asDays(org), user: asDays(user), content: asDays(content) };
  const save = useMutation({
    mutationFn: () =>
      setPlatformRetention(api, {
        orgPurgeDays: values.org ?? 0,
        userPurgeDays: values.user ?? 0,
        contentPurgeDays: values.content ?? 0,
      }),
    onSuccess: () => refresh(),
    onError: (error) => refresh(error),
  });
  const error = t('PlatformSettings.retentionRange');
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="tm-ps-retention">
      <h2 id="tm-ps-retention" className="tm-cc-card__title">
        {t('PlatformSettings.retentionTitle')}
      </h2>
      <p className="tm-cc-note">{t('PlatformSettings.retentionBody')}</p>
      <form
        className="tm-stack tm-stack--tight"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (values.org !== null && values.user !== null && values.content !== null) save.mutate();
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 'var(--s3)',
          }}
        >
          <Field
            label={t('PlatformSettings.retentionOrganizations')}
            hint={t('PlatformSettings.days')}
            inputMode="numeric"
            value={org}
            disabled={!canEdit}
            onChange={(event) => setOrg(event.target.value)}
            {...(tried && values.org === null ? { error } : {})}
          />
          <Field
            label={t('PlatformSettings.retentionPeople')}
            hint={t('PlatformSettings.days')}
            inputMode="numeric"
            value={user}
            disabled={!canEdit}
            onChange={(event) => setUser(event.target.value)}
            {...(tried && values.user === null ? { error } : {})}
          />
          <Field
            label={t('PlatformSettings.retentionContent')}
            hint={t('PlatformSettings.days')}
            inputMode="numeric"
            value={content}
            disabled={!canEdit}
            onChange={(event) => setContent(event.target.value)}
            {...(tried && values.content === null ? { error } : {})}
          />
        </div>
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <div>
          <Button
            type="submit"
            tone="ink"
            size="compact"
            disabled={!canEdit}
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformSettings.saveRetention')}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Beta banner ─────────────────────────────────────────────────────────────

function BetaBannerCard({ api, view, canEdit }: CardProps) {
  const t = useT();
  const refresh = useRefresh();
  const [on, setOn] = useState(view.betaBanner.on);
  const [textEn, setTextEn] = useState(view.betaBanner.textEn);
  const [textAr, setTextAr] = useState(view.betaBanner.textAr);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setOn(view.betaBanner.on);
    setTextEn(view.betaBanner.textEn);
    setTextAr(view.betaBanner.textAr);
  }, [view.betaBanner]);
  const missingEnglish = on && textEn.trim() === '';
  const save = useMutation({
    mutationFn: () =>
      setPlatformBetaBanner(api, { on, textEn: textEn.trim(), textAr: textAr.trim() }),
    onSuccess: () => refresh(),
    onError: (error) => refresh(error),
  });
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="tm-ps-beta">
      <h2 id="tm-ps-beta" className="tm-cc-card__title">
        {t('PlatformSettings.betaTitle')}
      </h2>
      <form
        className="tm-stack tm-stack--tight"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!missingEnglish) save.mutate();
        }}
      >
        <div className="tm-cc-card__head">
          <div className="tm-stack tm-stack--tight">
            <span className="tm-cc-cell-title">{t('PlatformSettings.betaShow')}</span>
            <span className="tm-cc-note">{t('PlatformSettings.betaShowBody')}</span>
          </div>
          <Switch
            label={<VisuallyHidden>{t('PlatformSettings.betaShow')}</VisuallyHidden>}
            checked={on}
            disabled={!canEdit}
            onChange={(event) => setOn(event.target.checked)}
          />
        </div>
        <Field
          label={t('PlatformSettings.betaTextEn')}
          value={textEn}
          maxLength={255}
          disabled={!canEdit}
          onChange={(event) => setTextEn(event.target.value)}
          {...(tried && missingEnglish ? { error: t('PlatformSettings.betaTextEnRequired') } : {})}
        />
        <Field
          label={t('PlatformSettings.betaTextAr')}
          value={textAr}
          maxLength={255}
          dir="rtl"
          lang="ar"
          disabled={!canEdit}
          onChange={(event) => setTextAr(event.target.value)}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <div>
          <Button
            type="submit"
            tone="ink"
            size="compact"
            disabled={!canEdit}
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformSettings.saveBanner')}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Support sessions ────────────────────────────────────────────────────────

const SUPPORT_HOURS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function SupportCard({ api, view, canEdit }: CardProps) {
  const t = useT();
  const locale = useActiveLocale();
  const refresh = useRefresh();
  const save = useMutation({
    mutationFn: (next: { maxMinutes: number; requireReason: boolean }) =>
      setPlatformSupportDefaults(api, next),
    onSuccess: () => refresh(),
    onError: (error) => refresh(error),
  });
  const { maxMinutes, requireReason } = view.supportDefaults;
  const options = SUPPORT_HOURS.map((hours) => hours * 60);
  if (!options.includes(maxMinutes)) options.push(maxMinutes);
  options.sort((a, b) => a - b);
  const label = (minutes: number) =>
    minutes % 60 === 0
      ? fill(t('PlatformSettings.supportHoursOption'), { hours: minutes / 60, minutes })
      : fill(t('PlatformSettings.supportMinutesOption'), { minutes });
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" aria-labelledby="tm-ps-support">
      <h2 id="tm-ps-support" className="tm-cc-card__title">
        {t('PlatformSettings.supportTitle')}
      </h2>
      <p className="tm-cc-note">{t('PlatformSettings.supportBody')}</p>
      <Select
        label={t('PlatformSettings.supportLongest')}
        hint={t('PlatformSettings.supportLongestHint')}
        value={String(maxMinutes)}
        disabled={!canEdit || save.isPending}
        onChange={(event) => save.mutate({ maxMinutes: Number(event.target.value), requireReason })}
      >
        {options.map((minutes) => (
          <option key={minutes} value={minutes}>
            {label(minutes)}
          </option>
        ))}
      </Select>
      <div className="tm-cc-card__head">
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{t('PlatformSettings.supportRequireReason')}</span>
          <span className="tm-cc-note">{t('PlatformSettings.supportRequireReasonBody')}</span>
        </div>
        <Switch
          label={<VisuallyHidden>{t('PlatformSettings.supportRequireReason')}</VisuallyHidden>}
          checked={requireReason}
          disabled={!canEdit || save.isPending}
          onChange={(event) => save.mutate({ maxMinutes, requireReason: event.target.checked })}
        />
      </div>
      <hr className="tm-cc-rule" />
      <div className="tm-cc-card__head">
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{t('PlatformSettings.supportStepUp')}</span>
          <span className="tm-cc-note">
            {fill(t('PlatformSettings.supportStepUpBody'), {
              duration: formatWholeDuration(view.stepUpMinutes, locale),
            })}
          </span>
        </div>
        <span className="tm-cc-pill tm-cc-pill--muted">
          {fill(t('PlatformSettings.readOnlyMinutes'), {
            duration: formatWholeDuration(view.stepUpMinutes, locale),
          })}
        </span>
      </div>
      {save.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(save.error, t)}
        </InlineAlert>
      ) : null}
    </section>
  );
}

// ── Integrations ────────────────────────────────────────────────────────────

const INTEGRATION_LABELS: Record<PlatformIntegrationKey, MessageKey> = {
  google_drive: 'PlatformSettings.integrationGoogleDrive',
  onedrive: 'PlatformSettings.integrationOneDrive',
  google_calendar: 'PlatformSettings.integrationGoogleCalendar',
  microsoft_calendar: 'PlatformSettings.integrationMicrosoftCalendar',
  figma: 'platformServices.figma',
  github: 'platformServices.github',
  jira: 'platformServices.jira',
  email: 'platformServices.email',
  mcp: 'PlatformSettings.integrationMcp',
};

/** 51-15p — the row's state in words, never colour alone. */
function serviceState(row: PlatformIntegrationView): {
  readonly label: MessageKey;
  readonly tone: 'success' | 'neutral' | 'danger';
} {
  if (!row.switchable) {
    return row.configured
      ? { label: 'platformServices.stateAlwaysOn', tone: 'success' }
      : { label: 'platformServices.stateNotSetUp', tone: 'neutral' };
  }
  if (!row.configured) return { label: 'platformServices.stateNotSetUp', tone: 'neutral' };
  return row.enabled
    ? { label: 'platformServices.stateOn', tone: 'success' }
    : { label: 'platformServices.stateOff', tone: 'danger' };
}

function IntegrationsSection({ api, canEdit }: { api: ApiClient; canEdit: boolean }) {
  const t = useT();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PlatformIntegrationView | null>(null);
  const list = useQuery({
    queryKey: PLATFORM_INTEGRATIONS_QUERY_KEY,
    queryFn: () => fetchPlatformIntegrations(api),
  });

  return (
    <section className="tm-stack tm-stack--tight" aria-labelledby="tm-ps-integrations">
      <h2 id="tm-ps-integrations" className="tm-cc-eyebrow">
        {t('platformServices.title')}
      </h2>
      <p className="tm-cc-note">{t('PlatformSettings.integrationsBody')}</p>
      {list.isPending ? (
        <PlatformPageState state="loading" loadingLabel={t('platformServices.loading')} />
      ) : list.isError ? (
        <PlatformPageState
          state="error"
          error={list.error}
          title={t('PlatformSettings.integrationsError')}
          onRetry={() => void list.refetch()}
        />
      ) : list.data.integrations.length === 0 ? (
        <p className="tm-cc-note">{t('platformServices.empty')}</p>
      ) : (
        <PlatformTable<PlatformIntegrationView>
          label={t('platformServices.title')}
          rows={list.data.integrations}
          rowKey={(row) => row.key}
          columns={[
            {
              id: 'name',
              header: t('PlatformSettings.colIntegration'),
              cell: (row) => (
                <span className="tm-cc-cell-title">{t(INTEGRATION_LABELS[row.key])}</span>
              ),
            },
            {
              id: 'keys',
              header: t('PlatformSettings.colServerKeys'),
              cell: (row) => (
                <StatusDot tone={row.configured ? 'success' : 'neutral'}>
                  {row.configured
                    ? t('PlatformSettings.configured')
                    : t('PlatformSettings.notConfigured')}
                </StatusDot>
              ),
            },
            {
              id: 'state',
              header: t('platformServices.colState'),
              cell: (row) => {
                const state = serviceState(row);
                return (
                  <Tooltip
                    content={
                      row.switchable
                        ? t('platformServices.switchHelp')
                        : t('platformServices.alwaysOnHelp')
                    }
                  >
                    <button type="button" className="tm-cc-row-button">
                      <StatusDot tone={state.tone}>{t(state.label)}</StatusDot>
                    </button>
                  </Tooltip>
                );
              },
            },
            {
              id: 'on',
              header: t('PlatformSettings.colOnForTManage'),
              cell: (row) =>
                !row.switchable ? (
                  '—'
                ) : row.environmentForcedOff ? (
                  <span className="tm-cc-pill tm-cc-pill--muted">
                    {t('PlatformSettings.forcedOffByServer')}
                  </span>
                ) : (
                  <Switch
                    label={
                      <VisuallyHidden>
                        {fill(t('PlatformSettings.integrationSwitch'), {
                          name: t(INTEGRATION_LABELS[row.key]),
                        })}
                      </VisuallyHidden>
                    }
                    checked={row.enabled}
                    disabled={!canEdit || !row.configured}
                    onChange={() => setPending(row)}
                  />
                ),
            },
            {
              id: 'orgs',
              header: t('PlatformSettings.colConnectedOrgs'),
              kind: 'mono',
              cell: (row) => row.connectedOrganizations ?? '—',
            },
            {
              id: 'success',
              header: t('platformServices.colLastUse'),
              cell: (row) => formatShort(row.lastSuccessAt, locale),
            },
            {
              id: 'error',
              header: t('PlatformSettings.colLastError'),
              cell: (row) => {
                if (!row.configured && row.missingEnvironment.length > 0) {
                  return (
                    <span className="tm-cc-cell-sub">
                      {fill(t('PlatformSettings.addInHostinger'), {
                        name: row.missingEnvironment[0] ?? '',
                      })}
                    </span>
                  );
                }
                if (row.environmentForcedOff) {
                  return (
                    <span className="tm-cc-cell-sub">{t('PlatformSettings.serverSwitchWins')}</span>
                  );
                }
                if (row.lastErrorCode) {
                  return (
                    <StatusDot tone="danger">
                      <bdi dir="ltr">{row.lastErrorCode}</bdi> ·{' '}
                      {formatShort(row.lastErrorAt, locale)}
                    </StatusDot>
                  );
                }
                return '—';
              },
            },
            {
              id: 'open',
              header: <VisuallyHidden>{t('PlatformSettings.openList')}</VisuallyHidden>,
              cell: (row) =>
                (row.connectedOrganizations ?? 0) > 0 ? (
                  <Link
                    href="/platform/organizations"
                    className="tm-button tm-button--outline tm-button--compact"
                  >
                    {t('PlatformSettings.openList')}
                  </Link>
                ) : (
                  <span
                    className="tm-button tm-button--outline tm-button--compact"
                    aria-disabled="true"
                    style={{ opacity: 0.45 }}
                  >
                    {t('PlatformSettings.openList')}
                  </span>
                ),
            },
          ]}
        />
      )}
      {pending ? (
        <ReasonDialog
          title={fill(
            pending.enabled
              ? t('PlatformSettings.integrationOffTitle')
              : t('PlatformSettings.integrationOnTitle'),
            { name: t(INTEGRATION_LABELS[pending.key]) },
          )}
          body={fill(
            pending.enabled ? t('platformServices.offBody') : t('platformServices.onBody'),
            { name: t(INTEGRATION_LABELS[pending.key]) },
          )}
          reasonRequired
          destructive={pending.enabled}
          confirmLabel={
            pending.enabled ? t('PlatformSettings.turnOff') : t('PlatformSettings.turnOn')
          }
          onConfirm={async (reason) => {
            await setPlatformIntegration(api, pending.key, !pending.enabled, reason ?? '');
          }}
          onClose={(done) => {
            setPending(null);
            if (done) {
              void queryClient.invalidateQueries({ queryKey: PLATFORM_INTEGRATIONS_QUERY_KEY });
              void queryClient.invalidateQueries({ queryKey: PLATFORM_SETTINGS_QUERY_KEY });
            }
          }}
        />
      ) : null}
    </section>
  );
}

function formatShort(iso: string | null, locale: string): string {
  if (iso === null) return '—';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const minutes = Math.round((Date.now() - at) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  if (minutes < 60 * 48) return format.format(-Math.round(minutes / 60), 'hour');
  return format.format(-Math.round(minutes / 1440), 'day');
}
