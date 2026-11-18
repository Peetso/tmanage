'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Switch, Tooltip } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  PLATFORM_PERSON_MAIL_QUERY_KEY,
  addFeatureNews,
  fetchPersonMail,
  sendFeatureNews,
  setTipsSwitch,
} from '../../../lib/api/platform-person-mail';
import type { FeatureNewsInput, FeatureNewsView } from '../../../lib/api/platform-person-mail';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';

/**
 * EMAILBUILD2 — the "Tips and reminders" switch and the "Feature news" card (platform settings,
 * General). The switch stops every tip, reminder and news mail (the security follow-up after a
 * new-device sign-in still goes). A note is written once and sent once; the hourly sweep then
 * delivers it to every team member with tips on. Every rule (lengths, link shape, once-only,
 * audit) is the server's.
 */

/** A second send is the server's 409; the reader sees it in their own language. */
function sendError(error: Error, t: ReturnType<typeof useT>): string {
  return error instanceof ApiRequestError && error.status === 409
    ? t('PlatformPersonMail.alreadySent')
    : platformErrorText(error, t);
}

export function FeatureNewsCard({ api, canEdit }: { api: ApiClient; canEdit: boolean }) {
  const t = useT();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const state = useQuery({
    queryKey: PLATFORM_PERSON_MAIL_QUERY_KEY,
    queryFn: () => fetchPersonMail(api),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setTipsSwitch(api, enabled),
    onSuccess: (view) => queryClient.setQueryData(PLATFORM_PERSON_MAIL_QUERY_KEY, view),
  });
  const send = useMutation({
    mutationFn: (note: FeatureNewsView) => sendFeatureNews(api, note.id),
    onSuccess: (view) => queryClient.setQueryData(PLATFORM_PERSON_MAIL_QUERY_KEY, view),
  });
  const actionError =
    toggle.error !== null
      ? platformErrorText(toggle.error, t)
      : send.error !== null
        ? sendError(send.error, t)
        : null;
  const arabic = locale.startsWith('ar');

  return (
    <section className="tm-stack tm-stack--tight" aria-labelledby="tm-ps-feature-news">
      <div className="tm-cc-card__head">
        <div className="tm-stack tm-stack--tight">
          <h2 id="tm-ps-feature-news" className="tm-cc-eyebrow">
            {t('PlatformPersonMail.title')}
          </h2>
          <p className="tm-cc-note">{t('PlatformPersonMail.helper')}</p>
        </div>
        <Button
          type="button"
          tone="ink"
          size="compact"
          disabled={!canEdit}
          onClick={() => setAdding(true)}
        >
          {t('PlatformPersonMail.addNote')}
        </Button>
      </div>
      {state.data !== undefined ? (
        <Switch
          label={t('PlatformPersonMail.switchLabel')}
          hint={t('PlatformPersonMail.switchHint')}
          checked={state.data.tipsEnabled}
          disabled={!canEdit || toggle.isPending}
          onChange={() => toggle.mutate(!state.data.tipsEnabled)}
        />
      ) : null}
      {actionError !== null ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {actionError}
        </InlineAlert>
      ) : null}
      {state.isPending ? (
        <PlatformPageState state="loading" loadingLabel={t('PlatformPersonMail.loading')} />
      ) : state.isError ? (
        <PlatformPageState
          state="error"
          error={state.error}
          title={t('PlatformPersonMail.loadError')}
          onRetry={() => void state.refetch()}
        />
      ) : state.data.news.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformPersonMail.empty')}</p>
      ) : (
        <PlatformTable<FeatureNewsView>
          label={t('PlatformPersonMail.title')}
          rows={state.data.news}
          rowKey={(row) => row.id}
          isMuted={(row) => row.sentAt !== null}
          columns={[
            {
              id: 'title',
              header: t('PlatformPersonMail.colTitle'),
              cell: (row) =>
                arabic ? (
                  <bdi dir="rtl" lang="ar" className="tm-cc-cell-title">
                    {row.titleAr}
                  </bdi>
                ) : (
                  <span className="tm-cc-cell-title">{row.titleEn}</span>
                ),
            },
            {
              id: 'link',
              header: t('PlatformPersonMail.colLink'),
              kind: 'mono',
              cell: (row) => <bdi dir="ltr">{row.link}</bdi>,
            },
            {
              id: 'status',
              header: t('PlatformPersonMail.colStatus'),
              cell: (row) =>
                row.sentAt === null
                  ? t('PlatformPersonMail.statusDraft')
                  : t('PlatformPersonMail.statusSent'),
            },
            {
              id: 'send',
              header: t('PlatformPersonMail.send'),
              cell: (row) =>
                row.sentAt === null ? (
                  <Tooltip content={t('PlatformPersonMail.sendHelp')}>
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      disabled={!canEdit}
                      loading={send.isPending && send.variables.id === row.id}
                      loadingLabel={t('PlatformShared.working')}
                      onClick={() => send.mutate(row)}
                    >
                      {t('PlatformPersonMail.send')}
                    </Button>
                  </Tooltip>
                ) : null,
            },
          ]}
        />
      )}
      {adding ? <AddNoteDialog api={api} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

const EMPTY: FeatureNewsInput = { titleEn: '', titleAr: '', bodyEn: '', bodyAr: '', link: '' };

function AddNoteDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FeatureNewsInput>(EMPTY);
  const set = (key: keyof FeatureNewsInput, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () => addFeatureNews(api, draft),
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_PERSON_MAIL_QUERY_KEY, view);
      onClose();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <PlatformDialog title={t('PlatformPersonMail.addTitle')} onClose={onClose}>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <Field
          label={t('PlatformPersonMail.fieldTitleEn')}
          value={draft.titleEn}
          maxLength={120}
          required
          onChange={(event) => set('titleEn', event.target.value)}
        />
        <Field
          label={t('PlatformPersonMail.fieldTitleAr')}
          value={draft.titleAr}
          maxLength={120}
          dir="rtl"
          lang="ar"
          required
          onChange={(event) => set('titleAr', event.target.value)}
        />
        <Field
          label={t('PlatformPersonMail.fieldBodyEn')}
          hint={t('PlatformPersonMail.bodyHint')}
          value={draft.bodyEn}
          maxLength={400}
          required
          onChange={(event) => set('bodyEn', event.target.value)}
        />
        <Field
          label={t('PlatformPersonMail.fieldBodyAr')}
          hint={t('PlatformPersonMail.bodyHint')}
          value={draft.bodyAr}
          maxLength={400}
          dir="rtl"
          lang="ar"
          required
          onChange={(event) => set('bodyAr', event.target.value)}
        />
        <Field
          label={t('PlatformPersonMail.fieldLink')}
          hint={t('PlatformPersonMail.linkHint')}
          value={draft.link}
          maxLength={500}
          dir="ltr"
          required
          onChange={(event) => set('link', event.target.value)}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformPersonMail.addNote')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
