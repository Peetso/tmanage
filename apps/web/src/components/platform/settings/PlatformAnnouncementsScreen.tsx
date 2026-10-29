'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, SearchField, Switch, VisuallyHidden } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { listPlatformCompanies } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_ANNOUNCEMENTS_QUERY_KEY,
  archivePlatformAnnouncement,
  createPlatformAnnouncement,
  fetchPlatformAnnouncements,
  setPlatformAnnouncementPublished,
  updatePlatformAnnouncement,
} from '../../../lib/api/platform-settings';
import type {
  AnnouncementAudience,
  AnnouncementInput,
  AnnouncementSeverity,
  AnnouncementStatus,
  PlatformAnnouncementView,
} from '../../../lib/api/platform-settings';
import type { MessageKey } from '../../../lib/i18n/t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { AnnouncementBannerView } from '../announcements/PlatformAnnouncementBanner';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import {
  ChipGroup,
  SettingsSubNav,
  fill,
  formatWhen,
  fromLocalInput,
  toLocalInput,
} from './settings-kit';

/**
 * D3 · Announcements (`/platform/settings/announcements`, frames 435:20257 and 435:20626 empty).
 * A banner for everyone, chosen organizations or client portals, always written in English and
 * Arabic; drafts are visible only here until Publish.
 */

export const STATUS_LABELS: Record<AnnouncementStatus, MessageKey> = {
  draft: 'PlatformSettings.statusDraft',
  scheduled: 'PlatformSettings.statusScheduled',
  live: 'PlatformSettings.statusLive',
  expired: 'PlatformSettings.statusExpired',
};

const SEVERITY_LABELS: Record<AnnouncementSeverity, MessageKey> = {
  info: 'PlatformSettings.severityInfo',
  warning: 'PlatformSettings.severityWarning',
  critical: 'PlatformSettings.severityCritical',
};

const AUDIENCE_LABELS: Record<AnnouncementAudience, MessageKey> = {
  everyone: 'PlatformSettings.audienceEveryone',
  organizations: 'PlatformSettings.audienceChosen',
  clients: 'PlatformSettings.audienceClients',
};

type Filter = 'all' | AnnouncementStatus;

export function PlatformAnnouncementsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [editing, setEditing] = useState<PlatformAnnouncementView | 'new' | null>(null);
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), t('PlatformSettings.navAnnouncements')]}
      title={t('PlatformSettings.announcementsTitle')}
      description={t('PlatformSettings.announcementsDescription')}
      actions={(me) =>
        me.permissions.includes('platform.announcements.edit') ? (
          <Button type="button" tone="lime" onClick={() => setEditing('new')}>
            {t('PlatformSettings.newAnnouncement')}
          </Button>
        ) : null
      }
    >
      {(me) => <AnnouncementsBody api={api} me={me} editing={editing} setEditing={setEditing} />}
    </PlatformGate>
  );
}

function AnnouncementsBody({
  api,
  me,
  editing,
  setEditing,
}: {
  api: ApiClient;
  me: PlatformMeView;
  editing: PlatformAnnouncementView | 'new' | null;
  setEditing: (next: PlatformAnnouncementView | 'new' | null) => void;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const [filter, setFilter] = useState<Filter>('all');
  const list = useQuery({
    queryKey: PLATFORM_ANNOUNCEMENTS_QUERY_KEY,
    queryFn: () => fetchPlatformAnnouncements(api),
  });
  const canEdit = me.permissions.includes('platform.announcements.edit');

  if (list.isPending) {
    return (
      <>
        <SettingsSubNav active="announcements" />
        <PlatformPageState
          state="loading"
          loadingLabel={t('PlatformSettings.announcementsLoading')}
        />
      </>
    );
  }
  if (list.isError) {
    const missing = missingPlatformPermission(list.error);
    return (
      <>
        <SettingsSubNav active="announcements" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
        )}
      </>
    );
  }

  const all = list.data.announcements;
  const count = (status: AnnouncementStatus) => all.filter((row) => row.status === status).length;
  const rows = filter === 'all' ? all : all.filter((row) => row.status === filter);
  const windowText = (row: PlatformAnnouncementView) =>
    row.startsAt === null && row.endsAt === null
      ? t('PlatformSettings.noWindow')
      : `${formatWhen(row.startsAt, locale)} → ${formatWhen(row.endsAt, locale)}`;

  return (
    <div className="tm-stack">
      <SettingsSubNav active="announcements" />
      <ChipGroup<Filter>
        label={t('PlatformSettings.filterLabel')}
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: `${t('PlatformSettings.filterAll')} · ${all.length}` },
          { value: 'live', label: `${t('PlatformSettings.statusLive')} · ${count('live')}` },
          {
            value: 'scheduled',
            label: `${t('PlatformSettings.statusScheduled')} · ${count('scheduled')}`,
          },
          { value: 'draft', label: `${t('PlatformSettings.filterDrafts')} · ${count('draft')}` },
          {
            value: 'expired',
            label: `${t('PlatformSettings.statusExpired')} · ${count('expired')}`,
          },
        ]}
      />
      {all.length === 0 && editing === null ? (
        <section className="tm-cc-card tm-stack tm-stack--tight" data-state="empty">
          <p className="tm-cc-eyebrow">{t('PlatformSettings.emptyEyebrow')}</p>
          <h2 className="tm-cc-card__title">{t('PlatformSettings.emptyTitle')}</h2>
          <p className="tm-cc-note">{t('PlatformSettings.emptyBody')}</p>
          {canEdit ? (
            <div>
              <Button type="button" tone="lime" onClick={() => setEditing('new')}>
                {t('PlatformSettings.newAnnouncement')}
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <PlatformTable<PlatformAnnouncementView>
          label={t('PlatformSettings.announcementsTitle')}
          rows={rows}
          rowKey={(row) => row.id}
          isMuted={(row) => row.status === 'expired'}
          columns={[
            {
              id: 'title',
              header: t('PlatformSettings.colTitle'),
              cell: (row) => (
                <>
                  <span className="tm-cc-cell-title">{row.titleEn}</span>
                  {row.titleAr ? (
                    <span className="tm-cc-cell-sub" dir="rtl" lang="ar">
                      {row.titleAr}
                    </span>
                  ) : null}
                </>
              ),
            },
            {
              id: 'severity',
              header: t('PlatformSettings.colSeverity'),
              cell: (row) => (
                <span
                  className={`tm-cc-pill${
                    row.severity === 'critical'
                      ? ' tm-cc-pill--danger'
                      : row.severity === 'warning'
                        ? ' tm-cc-pill--warning'
                        : ' tm-cc-pill--muted'
                  }`}
                >
                  {t(SEVERITY_LABELS[row.severity])}
                </span>
              ),
            },
            {
              id: 'audience',
              header: t('PlatformSettings.colAudience'),
              cell: (row) =>
                row.audience === 'organizations'
                  ? fill(t('PlatformSettings.audienceChosenCount'), {
                      count: row.audienceOrganizationIds.length,
                    })
                  : t(AUDIENCE_LABELS[row.audience]),
            },
            { id: 'window', header: t('PlatformSettings.colWindow'), cell: windowText },
            {
              id: 'status',
              header: t('PlatformSettings.colStatus'),
              cell: (row) => (
                <span
                  className={`tm-cc-pill${row.status === 'live' ? ' tm-cc-pill--on' : ' tm-cc-pill--muted'}`}
                >
                  {t(STATUS_LABELS[row.status])}
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
                  disabled={!canEdit}
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
        <AnnouncementEditor
          key={editing === 'new' ? 'new' : editing.id}
          api={api}
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

interface Draft {
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  severity: AnnouncementSeverity;
  audience: AnnouncementAudience;
  audienceOrganizationIds: readonly string[];
  dismissible: boolean;
  startsAt: string;
  endsAt: string;
  linkUrl: string;
}

function draftOf(existing: PlatformAnnouncementView | null): Draft {
  return {
    titleEn: existing?.titleEn ?? '',
    titleAr: existing?.titleAr ?? '',
    bodyEn: existing?.bodyEn ?? '',
    bodyAr: existing?.bodyAr ?? '',
    severity: existing?.severity ?? 'info',
    audience: existing?.audience ?? 'everyone',
    audienceOrganizationIds: existing?.audienceOrganizationIds ?? [],
    dismissible: existing?.dismissible ?? true,
    startsAt: toLocalInput(existing?.startsAt ?? null),
    endsAt: toLocalInput(existing?.endsAt ?? null),
    linkUrl: existing?.linkUrl ?? '',
  };
}

function inputOf(draft: Draft): AnnouncementInput {
  const optional = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    titleEn: draft.titleEn.trim(),
    titleAr: optional(draft.titleAr),
    bodyEn: draft.bodyEn.trim(),
    bodyAr: optional(draft.bodyAr),
    severity: draft.severity,
    linkUrl: optional(draft.linkUrl),
    audience: draft.audience,
    audienceOrganizationIds:
      draft.audience === 'organizations' ? draft.audienceOrganizationIds : [],
    dismissible: draft.dismissible,
    startsAt: fromLocalInput(draft.startsAt),
    endsAt: fromLocalInput(draft.endsAt),
  };
}

/** The editor (frame 435:20257 right column): EN | AR, severity, audience, window, preview. */
function AnnouncementEditor({
  api,
  existing,
  onDone,
}: {
  api: ApiClient;
  existing: PlatformAnnouncementView | null;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(existing));
  const [tried, setTried] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgNames, setOrgNames] = useState<ReadonlyMap<string, string>>(new Map());
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const companies = useQuery({
    queryKey: ['platform', 'companies', 'search', orgSearch.trim()],
    queryFn: () => listPlatformCompanies(api, orgSearch),
    enabled: draft.audience === 'organizations' && orgSearch.trim().length >= 2,
  });

  const missingTitle = draft.titleEn.trim() === '';
  const missingBody = draft.bodyEn.trim() === '';
  const startsAt = fromLocalInput(draft.startsAt);
  const endsAt = fromLocalInput(draft.endsAt);
  const badWindow =
    startsAt !== null &&
    endsAt !== null &&
    new Date(startsAt).getTime() >= new Date(endsAt).getTime();
  const noOrganizations =
    draft.audience === 'organizations' && draft.audienceOrganizationIds.length === 0;
  const invalid = missingTitle || missingBody || badWindow || noOrganizations;

  const refresh = async (error?: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    }
    await queryClient.invalidateQueries({ queryKey: PLATFORM_ANNOUNCEMENTS_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const input = inputOf(draft);
      if (existing === null)
        return createPlatformAnnouncement(api, { ...input, published: publish });
      const updated = await updatePlatformAnnouncement(api, existing.id, input);
      if (publish && !updated.published) {
        return setPlatformAnnouncementPublished(api, existing.id, true);
      }
      return updated;
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => refresh(error),
  });
  const unpublish = useMutation({
    mutationFn: () => setPlatformAnnouncementPublished(api, existing?.id ?? '', false),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => refresh(error),
  });

  function submit(publish: boolean) {
    setTried(true);
    if (!invalid) save.mutate(publish);
  }

  const previewEn = {
    locale: 'en' as const,
    title: draft.titleEn || t('PlatformSettings.previewTitlePlaceholder'),
    body: draft.bodyEn,
    severity: draft.severity,
    linkUrl: draft.linkUrl.trim() === '' ? null : '#',
    dismissible: draft.dismissible,
  };
  const previewAr = {
    ...previewEn,
    locale: 'ar' as const,
    title: draft.titleAr || draft.titleEn || t('PlatformSettings.previewTitlePlaceholder'),
    body: draft.bodyAr || draft.bodyEn,
  };

  return (
    <section className="tm-cc-card tm-stack" aria-labelledby="tm-ps-announcement-editor">
      <div className="tm-stack tm-stack--tight">
        <h2 id="tm-ps-announcement-editor" className="tm-cc-card__title">
          {existing
            ? `${t('PlatformSettings.editPrefix')} · ${existing.titleEn}`
            : t('PlatformSettings.newAnnouncement')}
        </h2>
        <p className="tm-cc-note">{t('PlatformSettings.editorNote')}</p>
      </div>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit(true);
        }}
      >
        <div className="tm-cc-split tm-cc-split--even">
          <div className="tm-stack tm-stack--tight">
            <p className="tm-cc-eyebrow">{t('PlatformSettings.english')}</p>
            <Field
              label={t('PlatformSettings.titleLabel')}
              value={draft.titleEn}
              maxLength={160}
              onChange={(event) => set('titleEn', event.target.value)}
              {...(tried && missingTitle ? { error: t('PlatformSettings.requiredField') } : {})}
            />
            <Field
              label={t('PlatformSettings.messageLabel')}
              value={draft.bodyEn}
              maxLength={1000}
              onChange={(event) => set('bodyEn', event.target.value)}
              {...(tried && missingBody ? { error: t('PlatformSettings.requiredField') } : {})}
            />
          </div>
          <div className="tm-stack tm-stack--tight" dir="rtl" lang="ar">
            <p className="tm-cc-eyebrow">{t('PlatformSettings.arabicRtl')}</p>
            <Field
              label={t('PlatformSettings.titleLabelAr')}
              value={draft.titleAr}
              maxLength={160}
              onChange={(event) => set('titleAr', event.target.value)}
            />
            <Field
              label={t('PlatformSettings.messageLabelAr')}
              value={draft.bodyAr}
              maxLength={1000}
              onChange={(event) => set('bodyAr', event.target.value)}
            />
          </div>
        </div>
        <div className="tm-cc-split tm-cc-split--even">
          <ChipGroup<AnnouncementSeverity>
            label={t('PlatformSettings.severityLabel')}
            value={draft.severity}
            onChange={(value) => set('severity', value)}
            options={(['info', 'warning', 'critical'] as const).map((value) => ({
              value,
              label: t(SEVERITY_LABELS[value]),
            }))}
          />
          <ChipGroup<AnnouncementAudience>
            label={t('PlatformSettings.audienceLabel')}
            value={draft.audience}
            onChange={(value) => set('audience', value)}
            options={(['everyone', 'organizations', 'clients'] as const).map((value) => ({
              value,
              label: t(AUDIENCE_LABELS[value]),
            }))}
          />
        </div>
        {draft.audience === 'organizations' ? (
          <div className="tm-stack tm-stack--tight">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
              {draft.audienceOrganizationIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="tm-cc-pill"
                  onClick={() =>
                    set(
                      'audienceOrganizationIds',
                      draft.audienceOrganizationIds.filter((value) => value !== id),
                    )
                  }
                >
                  {orgNames.get(id) ?? id.slice(0, 8)} ×
                </button>
              ))}
            </div>
            <SearchField
              label={t('PlatformSettings.addOrganization')}
              labelVisible
              placeholder={t('PlatformSettings.searchOrganizations')}
              value={orgSearch}
              onChange={(event) => setOrgSearch(event.target.value)}
            />
            {companies.data ? (
              <ul className="tm-cc-rows">
                {companies.data.slice(0, 8).map((company) => (
                  <li key={company.id} className="tm-cc-card__head">
                    <span className="tm-cc-cell-title">{company.name}</span>
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      disabled={draft.audienceOrganizationIds.includes(company.id)}
                      onClick={() => {
                        setOrgNames((current) => new Map(current).set(company.id, company.name));
                        set('audienceOrganizationIds', [
                          ...draft.audienceOrganizationIds,
                          company.id,
                        ]);
                      }}
                    >
                      {t('PlatformSettings.add')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {tried && noOrganizations ? (
              <InlineAlert tone="danger">{t('PlatformSettings.chooseOrganization')}</InlineAlert>
            ) : null}
          </div>
        ) : null}
        <div className="tm-cc-card__head">
          <div className="tm-stack tm-stack--tight">
            <span className="tm-cc-eyebrow">{t('PlatformSettings.peopleCanClose')}</span>
            <span className="tm-cc-cell-title">{t('PlatformSettings.dismissible')}</span>
          </div>
          <Switch
            label={<VisuallyHidden>{t('PlatformSettings.dismissible')}</VisuallyHidden>}
            checked={draft.dismissible}
            onChange={(event) => set('dismissible', event.target.checked)}
          />
        </div>
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
          />
          <Field
            label={t('PlatformSettings.ends')}
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => set('endsAt', event.target.value)}
            {...(tried && badWindow ? { error: t('PlatformSettings.endAfterStart') } : {})}
          />
          <Field
            label={t('PlatformSettings.linkOptional')}
            value={draft.linkUrl}
            dir="ltr"
            maxLength={500}
            onChange={(event) => set('linkUrl', event.target.value)}
          />
        </div>
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">{t('PlatformSettings.previewLabel')}</p>
          <AnnouncementBannerView announcement={previewEn} />
          <AnnouncementBannerView announcement={previewAr} />
        </div>
        {save.isError || unpublish.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error ?? unpublish.error, t)}
          </InlineAlert>
        ) : null}
        <div className="tm-cc-hero__actions">
          <Button
            type="submit"
            tone="lime"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformSettings.publish')}
          </Button>
          <Button
            type="button"
            tone="outline"
            disabled={save.isPending}
            onClick={() => submit(false)}
          >
            {t('PlatformSettings.saveDraft')}
          </Button>
          {existing?.published ? (
            <Button
              type="button"
              tone="outline"
              loading={unpublish.isPending}
              loadingLabel={t('PlatformShared.working')}
              onClick={() => unpublish.mutate()}
            >
              {t('PlatformSettings.unpublish')}
            </Button>
          ) : null}
          {existing ? (
            <Button type="button" tone="text" onClick={() => setDeleting(true)}>
              {t('PlatformSettings.delete')}
            </Button>
          ) : null}
          <Button type="button" tone="text" onClick={onDone}>
            {t('PlatformShared.cancel')}
          </Button>
        </div>
      </form>
      {deleting && existing ? (
        <ReasonDialog
          title={fill(t('PlatformSettings.deleteAnnouncementTitle'), { title: existing.titleEn })}
          body={t('PlatformSettings.deleteAnnouncementBody')}
          reasonRequired={false}
          destructive
          confirmLabel={t('PlatformSettings.delete')}
          onConfirm={async () => {
            await archivePlatformAnnouncement(api, existing.id);
          }}
          onClose={(done) => {
            setDeleting(false);
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
