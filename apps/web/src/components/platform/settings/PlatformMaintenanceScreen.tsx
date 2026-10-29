'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Switch, VisuallyHidden } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  PLATFORM_MAINTENANCE_QUERY_KEY,
  endPlatformMaintenance,
  fetchPlatformMaintenance,
  schedulePlatformMaintenance,
  unpublishPlatformMaintenance,
  updatePlatformMaintenance,
} from '../../../lib/api/maintenance';
import type {
  MaintenanceSeverity,
  MaintenanceWindowInput,
  PlatformMaintenanceWindowView,
} from '../../../lib/api/maintenance';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import type { MessageKey } from '../../../lib/i18n/t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { AnnouncementBannerView } from '../announcements/PlatformAnnouncementBanner';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { REASON_MAX, REASON_MIN, ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { ChipGroup, SettingsSubNav, fill, fromLocalInput, toLocalInput } from './settings-kit';

/**
 * D4 · Maintenance mode (`/platform/settings/maintenance`, frames 436:18351 and 440:20171 End
 * now). Warn people before TManage goes down and, with severity Down, block sign-in for everyone
 * except platform admins while it is down. Times show in Cairo time, as drawn.
 */

const CAIRO = 'Africa/Cairo';

const SEVERITY_LABELS: Record<MaintenanceSeverity, MessageKey> = {
  down: 'PlatformSettings.severityDown',
  degraded: 'PlatformSettings.severityDegraded',
  info: 'PlatformSettings.severityInfo',
};

const STATE_LABELS: Record<PlatformMaintenanceWindowView['state'], MessageKey> = {
  active: 'PlatformSettings.stateActive',
  scheduled: 'PlatformSettings.stateScheduled',
  draft: 'PlatformSettings.statusDraft',
  ended: 'PlatformSettings.stateEnded',
};

export function cairoTime(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: CAIRO,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

export function cairoDay(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: CAIRO,
    day: 'numeric',
    month: 'short',
  }).format(at);
}

/** "1:24:08" left until `endsAt`, never negative. */
export function countdown(endsAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((new Date(endsAt).getTime() - now) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function PlatformMaintenanceScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [editing, setEditing] = useState<PlatformMaintenanceWindowView | 'new' | null>(null);
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), t('PlatformSettings.navMaintenance')]}
      title={t('PlatformSettings.maintenanceTitle')}
      description={t('PlatformSettings.maintenanceDescription')}
      actions={(me) =>
        me.permissions.includes('platform.announcements.edit') ? (
          <Button type="button" tone="lime" onClick={() => setEditing('new')}>
            {t('PlatformSettings.newWindow')}
          </Button>
        ) : null
      }
    >
      {(me) => <MaintenanceBody api={api} me={me} editing={editing} setEditing={setEditing} />}
    </PlatformGate>
  );
}

function MaintenanceBody({
  api,
  me,
  editing,
  setEditing,
}: {
  api: ApiClient;
  me: PlatformMeView;
  editing: PlatformMaintenanceWindowView | 'new' | null;
  setEditing: (next: PlatformMaintenanceWindowView | 'new' | null) => void;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const list = useQuery({
    queryKey: PLATFORM_MAINTENANCE_QUERY_KEY,
    queryFn: () => fetchPlatformMaintenance(api),
    refetchInterval: 60_000,
  });
  const canEdit = me.permissions.includes('platform.announcements.edit');
  const current = list.data?.current ?? null;
  useEffect(() => {
    if (!current) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [current]);

  if (list.isPending) {
    return (
      <>
        <SettingsSubNav active="maintenance" />
        <PlatformPageState
          state="loading"
          loadingLabel={t('PlatformSettings.maintenanceLoading')}
        />
      </>
    );
  }
  if (list.isError) {
    const missing = missingPlatformPermission(list.error);
    return (
      <>
        <SettingsSubNav active="maintenance" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
        )}
      </>
    );
  }

  const windows = list.data.windows;
  const message = (row: PlatformMaintenanceWindowView) =>
    locale.toLowerCase().startsWith('ar') && row.messageAr ? row.messageAr : row.message;

  return (
    <div className="tm-stack">
      <SettingsSubNav active="maintenance" />
      {current ? (
        <section
          className="tm-cc-card tm-cc-card--attention tm-cc-hero"
          aria-labelledby="tm-ps-maintenance-current"
          data-testid="maintenance-active"
        >
          <div className="tm-stack tm-stack--tight">
            <p className="tm-cc-eyebrow tm-cc-eyebrow--warning">
              {t('PlatformSettings.statusActiveNow')}
            </p>
            <h2 id="tm-ps-maintenance-current" className="tm-cc-card__lead">
              {message(current)}
            </h2>
            <p className="tm-cc-note">
              {fill(
                current.blockSignIn
                  ? t('PlatformSettings.activeLineBlocked')
                  : t('PlatformSettings.activeLineOpen'),
                {
                  start: cairoTime(current.startsAt, locale),
                  end: cairoTime(current.endsAt, locale),
                },
              )}
            </p>
          </div>
          <div className="tm-stack tm-stack--tight" style={{ alignItems: 'flex-end' }}>
            <span className="tm-cc-metric__value" aria-live="off">
              {fill(t('PlatformSettings.timeLeft'), { time: countdown(current.endsAt, now) })}
            </span>
            {canEdit ? (
              <Button type="button" tone="destructive" onClick={() => setEnding(true)}>
                {t('PlatformSettings.endNow')}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {windows.length === 0 && editing === null ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformSettings.noWindowsTitle')}
          body={t('PlatformSettings.noWindowsBody')}
        />
      ) : (
        <PlatformTable<PlatformMaintenanceWindowView>
          label={t('PlatformSettings.maintenanceTitle')}
          rows={windows}
          rowKey={(row) => row.id}
          isMuted={(row) => row.state === 'ended'}
          columns={[
            {
              id: 'message',
              header: t('PlatformSettings.colMessage'),
              cell: (row) => <span className="tm-cc-cell-title">{message(row)}</span>,
            },
            {
              id: 'severity',
              header: t('PlatformSettings.colSeverity'),
              cell: (row) => (
                <span
                  className={`tm-cc-pill${
                    row.severity === 'down'
                      ? ' tm-cc-pill--danger'
                      : row.severity === 'degraded'
                        ? ' tm-cc-pill--warning'
                        : ' tm-cc-pill--muted'
                  }`}
                >
                  {t(SEVERITY_LABELS[row.severity])}
                </span>
              ),
            },
            {
              id: 'window',
              header: t('PlatformSettings.colWindowCairo'),
              cell: (row) =>
                `${cairoDay(row.startsAt, locale)} · ${cairoTime(row.startsAt, locale)}–${cairoTime(row.endsAt, locale)}`,
            },
            {
              id: 'signin',
              header: t('PlatformSettings.colSignIn'),
              cell: (row) =>
                row.blockSignIn && row.severity === 'down'
                  ? row.state === 'ended'
                    ? t('PlatformSettings.signInWasBlocked')
                    : t('PlatformSettings.signInBlocked')
                  : t('PlatformSettings.signInAllowed'),
            },
            {
              id: 'state',
              header: t('PlatformSettings.colState'),
              cell: (row) => (
                <span
                  className={`tm-cc-pill${
                    row.state === 'active'
                      ? ' tm-cc-pill--danger'
                      : row.state === 'scheduled'
                        ? ' tm-cc-pill--on'
                        : ' tm-cc-pill--muted'
                  }`}
                >
                  {t(STATE_LABELS[row.state])}
                </span>
              ),
            },
            {
              id: 'edit',
              header: <VisuallyHidden>{t('PlatformSettings.edit')}</VisuallyHidden>,
              cell: (row) => (
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  disabled={!canEdit || row.state === 'ended'}
                  onClick={() => setEditing(row)}
                >
                  {t('PlatformSettings.edit')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {editing !== null ? (
        <MaintenanceEditor
          key={editing === 'new' ? 'new' : editing.id}
          api={api}
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {ending && current ? (
        <ReasonDialog
          eyebrow={t('PlatformSettings.endEyebrow')}
          title={t('PlatformSettings.endTitle')}
          body={fill(t('PlatformSettings.endBody'), {
            time: cairoTime(new Date().toISOString(), locale),
          })}
          reasonRequired={false}
          destructive
          confirmLabel={t('PlatformSettings.endNow')}
          note={t('PlatformSettings.endNote')}
          onConfirm={async (reason) => {
            await endPlatformMaintenance(api, current.id, reason ?? undefined);
          }}
          onClose={(done) => {
            setEnding(false);
            if (done)
              void queryClient.invalidateQueries({ queryKey: PLATFORM_MAINTENANCE_QUERY_KEY });
          }}
        />
      ) : null}
    </div>
  );
}

interface Draft {
  message: string;
  messageAr: string;
  severity: MaintenanceSeverity;
  startsAt: string;
  endsAt: string;
  published: boolean;
  blockSignIn: boolean;
  reason: string;
}

function draftOf(existing: PlatformMaintenanceWindowView | null): Draft {
  return {
    message: existing?.message ?? '',
    messageAr: existing?.messageAr ?? '',
    severity: existing?.severity ?? 'down',
    startsAt: toLocalInput(existing?.startsAt ?? null),
    endsAt: toLocalInput(existing?.endsAt ?? null),
    published: existing?.published ?? true,
    blockSignIn: existing?.blockSignIn ?? false,
    reason: '',
  };
}

/** The window editor (frame 436:18351 right column). */
function MaintenanceEditor({
  api,
  existing,
  onDone,
}: {
  api: ApiClient;
  existing: PlatformMaintenanceWindowView | null;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(existing));
  const [tried, setTried] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const startsAt = fromLocalInput(draft.startsAt);
  const endsAt = fromLocalInput(draft.endsAt);
  const trimmedReason = draft.reason.trim();
  // Creating a window needs a typed reason (the API's schedule route); editing does not.
  const reasonInvalid =
    existing === null
      ? trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX
      : trimmedReason.length > 0 &&
        (trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX);
  const errors = {
    message: draft.message.trim() === '',
    startsAt: startsAt === null,
    endsAt: endsAt === null || (startsAt !== null && new Date(startsAt) >= new Date(endsAt)),
    reason: reasonInvalid,
  };
  const invalid = Object.values(errors).some(Boolean);
  const blockAllowed = draft.severity === 'down';

  const refresh = async (error?: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    }
    await queryClient.invalidateQueries({ queryKey: PLATFORM_MAINTENANCE_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: async () => {
      const input: MaintenanceWindowInput = {
        message: draft.message.trim(),
        messageAr: draft.messageAr.trim() === '' ? null : draft.messageAr.trim(),
        severity: draft.severity,
        startsAt: startsAt ?? '',
        endsAt: endsAt ?? '',
        published: draft.published,
        blockSignIn: blockAllowed && draft.blockSignIn,
        ...(trimmedReason !== '' ? { reason: trimmedReason } : {}),
      };
      if (existing === null) await schedulePlatformMaintenance(api, input);
      else await updatePlatformMaintenance(api, existing.id, input);
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => refresh(error),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!invalid) save.mutate();
  }

  const preview = {
    locale: 'en' as const,
    title: draft.message || t('PlatformSettings.previewTitlePlaceholder'),
    body: '',
    severity:
      draft.severity === 'down'
        ? ('critical' as const)
        : draft.severity === 'degraded'
          ? ('warning' as const)
          : ('info' as const),
    linkUrl: null,
    dismissible: false,
  };

  return (
    <section className="tm-cc-card tm-stack" aria-labelledby="tm-ps-maintenance-editor">
      <div className="tm-stack tm-stack--tight">
        <h2 id="tm-ps-maintenance-editor" className="tm-cc-card__title">
          {existing
            ? `${t('PlatformSettings.editPrefix')} · ${existing.message}`
            : t('PlatformSettings.newWindow')}
        </h2>
        <p className="tm-cc-note">{t('PlatformSettings.maintenanceEditorNote')}</p>
      </div>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <div className="tm-cc-split tm-cc-split--even">
          <Field
            label={t('PlatformSettings.messageEnglish')}
            value={draft.message}
            maxLength={500}
            onChange={(event) => set('message', event.target.value)}
            {...(tried && errors.message ? { error: t('PlatformSettings.requiredField') } : {})}
          />
          <div dir="rtl" lang="ar">
            <Field
              label={t('PlatformSettings.messageArabic')}
              value={draft.messageAr}
              maxLength={500}
              onChange={(event) => set('messageAr', event.target.value)}
            />
          </div>
        </div>
        <ChipGroup<MaintenanceSeverity>
          label={t('PlatformSettings.severityLabel')}
          value={draft.severity}
          onChange={(value) => set('severity', value)}
          options={(['down', 'degraded', 'info'] as const).map((value) => ({
            value,
            label: t(SEVERITY_LABELS[value]),
          }))}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--s3)',
          }}
        >
          <Field
            label={t('PlatformSettings.starts')}
            type="datetime-local"
            value={draft.startsAt}
            onChange={(event) => set('startsAt', event.target.value)}
            {...(tried && errors.startsAt ? { error: t('PlatformSettings.requiredField') } : {})}
          />
          <Field
            label={t('PlatformSettings.ends')}
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => set('endsAt', event.target.value)}
            {...(tried && errors.endsAt ? { error: t('PlatformSettings.endAfterStart') } : {})}
          />
        </div>
        <div className="tm-cc-card__head">
          <div className="tm-stack tm-stack--tight">
            <span className="tm-cc-cell-title">{t('PlatformSettings.publishNow')}</span>
            <span className="tm-cc-note">{t('PlatformSettings.publishNowBody')}</span>
          </div>
          <Switch
            label={<VisuallyHidden>{t('PlatformSettings.publishNow')}</VisuallyHidden>}
            checked={draft.published}
            onChange={(event) => set('published', event.target.checked)}
          />
        </div>
        <div className="tm-cc-card__head">
          <div className="tm-stack tm-stack--tight">
            <span className="tm-cc-cell-title">{t('PlatformSettings.blockSignIn')}</span>
            <span className="tm-cc-note">{t('PlatformSettings.blockSignInBody')}</span>
          </div>
          <Switch
            label={<VisuallyHidden>{t('PlatformSettings.blockSignIn')}</VisuallyHidden>}
            checked={blockAllowed && draft.blockSignIn}
            disabled={!blockAllowed}
            onChange={(event) => set('blockSignIn', event.target.checked)}
          />
        </div>
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">{t('PlatformSettings.previewLabel')}</p>
          <AnnouncementBannerView announcement={preview} />
        </div>
        <Field
          label={
            existing === null
              ? t('PlatformSettings.reasonRequiredLabel')
              : t('PlatformSettings.reasonOptionalLabel')
          }
          hint={t('PlatformSettings.reasonAuditHint')}
          value={draft.reason}
          maxLength={REASON_MAX}
          onChange={(event) => set('reason', event.target.value)}
          {...(tried && errors.reason ? { error: t('PlatformShared.reasonError') } : {})}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <div className="tm-cc-hero__actions">
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformSettings.saveWindow')}
          </Button>
          {existing?.published ? (
            <Button type="button" tone="outline" onClick={() => setUnpublishing(true)}>
              {t('PlatformSettings.unpublish')}
            </Button>
          ) : null}
          <Button type="button" tone="text" onClick={onDone}>
            {t('PlatformShared.cancel')}
          </Button>
        </div>
      </form>
      {unpublishing && existing ? (
        <ReasonDialog
          title={t('PlatformSettings.unpublishWindowTitle')}
          reasonRequired
          confirmLabel={t('PlatformSettings.unpublish')}
          onConfirm={async (reason) => {
            await unpublishPlatformMaintenance(api, existing.id, reason ?? '');
          }}
          onClose={(done) => {
            setUnpublishing(false);
            if (done) {
              void refresh();
              onDone();
            }
          }}
        />
      ) : null}
    </section>
  );
}
