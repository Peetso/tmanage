'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select, Switch, Tooltip, VisuallyHidden } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  MAIL_PERSON_LANGUAGE_VALUES,
  MAIL_PERSON_REGION_VALUES,
  MAIL_PERSON_TOPIC_VALUES,
  PLATFORM_MAIL_PEOPLE_QUERY_KEY,
  addMailPerson,
  fetchMailPeople,
  importMailPeople,
  sendMailPersonTest,
  setMailPersonActive,
} from '../../../lib/api/platform-mail-people';
import type {
  MailPeopleView,
  MailboxLoginView,
  MailPersonInput,
  MailPersonLanguages,
  MailPersonRegion,
  MailPersonTestView,
  MailPersonTopic,
  MailPersonView,
} from '../../../lib/api/platform-mail-people';
import type { MessageKey } from '../../../lib/i18n/t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { fill } from './settings-kit';

/**
 * EMAILBUILD — the "E-mail people" card (platform settings, General): the TManage people who sign
 * tips and reminders, with Region and Topic. Add, import a list, switch someone off or on, and send
 * a test to yourself. Every rule (address domain, duplicates, audit) is the server's.
 */

const REGION_LABELS: Record<MailPersonRegion, MessageKey> = {
  me: 'PlatformMailPeople.regionMe',
  west: 'PlatformMailPeople.regionWest',
  asia: 'PlatformMailPeople.regionAsia',
};

const TOPIC_LABELS: Record<MailPersonTopic, MessageKey> = {
  onboarding: 'PlatformMailPeople.topicOnboarding',
  features: 'PlatformMailPeople.topicFeatures',
  news: 'PlatformMailPeople.topicNews',
  security: 'PlatformMailPeople.topicSecurity',
  success: 'PlatformMailPeople.topicSuccess',
};

const LANGUAGE_LABELS: Record<MailPersonLanguages, MessageKey> = {
  en: 'PlatformMailPeople.languagesEn',
  ar: 'PlatformMailPeople.languagesAr',
  'en+ar': 'PlatformMailPeople.languagesBoth',
};

type Dialog = 'add' | 'import' | null;

export function MailPeopleCard({ api, canEdit }: { api: ApiClient; canEdit: boolean }) {
  const t = useT();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [testResult, setTestResult] = useState<MailPersonTestView | null>(null);
  const list = useQuery({
    queryKey: PLATFORM_MAIL_PEOPLE_QUERY_KEY,
    queryFn: () => fetchMailPeople(api),
  });
  const toggle = useMutation({
    mutationFn: (person: MailPersonView) => setMailPersonActive(api, person.id, !person.active),
    onSuccess: (view) => queryClient.setQueryData(PLATFORM_MAIL_PEOPLE_QUERY_KEY, view),
  });
  const test = useMutation({
    mutationFn: (person: MailPersonView) =>
      sendMailPersonTest(api, person.id, locale.startsWith('ar') ? 'ar' : 'en'),
    onMutate: () => setTestResult(null),
    onSuccess: (result) => setTestResult(result),
  });
  const actionError = toggle.error ?? test.error;

  return (
    <section className="tm-stack tm-stack--tight" aria-labelledby="tm-ps-mail-people">
      <div className="tm-cc-card__head">
        <div className="tm-stack tm-stack--tight">
          <h2 id="tm-ps-mail-people" className="tm-cc-eyebrow">
            {t('PlatformMailPeople.title')}
          </h2>
          <p className="tm-cc-note">{t('PlatformMailPeople.helper')}</p>
        </div>
        <div className="tm-row tm-row--wrap">
          <Button
            type="button"
            tone="outline"
            size="compact"
            disabled={!canEdit}
            onClick={() => setDialog('import')}
          >
            {t('PlatformMailPeople.importList')}
          </Button>
          <Button
            type="button"
            tone="ink"
            size="compact"
            disabled={!canEdit}
            onClick={() => setDialog('add')}
          >
            {t('PlatformMailPeople.addPerson')}
          </Button>
        </div>
      </div>
      {testResult !== null ? (
        <InlineAlert tone={testResult.sent ? 'success' : 'danger'} live>
          {testLine(testResult, t)}
        </InlineAlert>
      ) : null}
      {actionError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(actionError, t)}
        </InlineAlert>
      ) : null}
      {list.data !== undefined ? <MailboxLoginAlerts view={list.data} t={t} /> : null}
      {list.isPending ? (
        <PlatformPageState state="loading" loadingLabel={t('PlatformMailPeople.loading')} />
      ) : list.isError ? (
        <PlatformPageState
          state="error"
          error={list.error}
          title={t('PlatformMailPeople.loadError')}
          onRetry={() => void list.refetch()}
        />
      ) : list.data.people.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformMailPeople.empty')}</p>
      ) : (
        <PlatformTable<MailPersonView>
          label={t('PlatformMailPeople.title')}
          rows={list.data.people}
          rowKey={(row) => row.id}
          isMuted={(row) => !row.active}
          columns={[
            {
              id: 'name',
              header: t('PlatformMailPeople.colName'),
              cell: (row) => <span className="tm-cc-cell-title">{row.nameEn}</span>,
            },
            {
              id: 'nameAr',
              header: t('PlatformMailPeople.colNameAr'),
              cell: (row) => (
                <bdi dir="rtl" lang="ar">
                  {row.nameAr}
                </bdi>
              ),
            },
            {
              id: 'role',
              header: t('PlatformMailPeople.colRole'),
              cell: (row) => (locale.startsWith('ar') ? row.roleAr : row.roleEn),
            },
            {
              id: 'address',
              header: t('PlatformMailPeople.colAddress'),
              kind: 'mono',
              cell: (row) => <bdi dir="ltr">{row.address}</bdi>,
            },
            {
              id: 'languages',
              header: t('PlatformMailPeople.colLanguages'),
              cell: (row) => t(LANGUAGE_LABELS[row.languages]),
            },
            {
              id: 'region',
              header: t('PlatformMailPeople.colRegion'),
              cell: (row) => t(REGION_LABELS[row.region]),
            },
            {
              id: 'topic',
              header: (
                <Tooltip content={t('PlatformMailPeople.topicHelp')}>
                  <button type="button" className="tm-cc-row-button">
                    {t('PlatformMailPeople.colTopic')}
                  </button>
                </Tooltip>
              ),
              cell: (row) => t(TOPIC_LABELS[row.topic]),
            },
            {
              id: 'active',
              header: t('PlatformMailPeople.colActive'),
              cell: (row) => (
                <Switch
                  label={
                    <VisuallyHidden>
                      {fill(t('PlatformMailPeople.switchLabel'), { name: row.nameEn })}
                    </VisuallyHidden>
                  }
                  checked={row.active}
                  disabled={!canEdit || toggle.isPending}
                  onChange={() => toggle.mutate(row)}
                />
              ),
            },
            {
              id: 'test',
              header: <VisuallyHidden>{t('PlatformMailPeople.sendTest')}</VisuallyHidden>,
              cell: (row) => (
                <Tooltip content={t('PlatformMailPeople.sendTestHelp')}>
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    disabled={!canEdit}
                    loading={test.isPending && test.variables.id === row.id}
                    loadingLabel={t('PlatformShared.working')}
                    onClick={() => test.mutate(row)}
                  >
                    {t('PlatformMailPeople.sendTest')}
                  </Button>
                </Tooltip>
              ),
            },
          ]}
        />
      )}
      {dialog === 'add' ? <AddPersonDialog api={api} onClose={() => setDialog(null)} /> : null}
      {dialog === 'import' ? <ImportDialog api={api} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

/**
 * MAILSTATUS (ADR-0013). A mailbox whose login the mail server refuses (or that it cannot reach)
 * sends nothing; the card says which, by address, never a value.
 */
function MailboxLoginAlerts({ view, t }: { view: MailPeopleView; t: ReturnType<typeof useT> }) {
  const named = (state: MailboxLoginView['state']) =>
    (view.mailboxes ?? [])
      .filter((m) => m.state === state)
      .map((m) => m.address ?? m.mailbox)
      .join(', ');
  const refused = named('login_refused');
  const unreachable = named('unreachable');
  return (
    <>
      {refused !== '' ? (
        <InlineAlert tone="danger" title={t('PlatformMailPeople.loginRefusedTitle')}>
          {fill(t('PlatformMailPeople.loginRefused'), { addresses: refused })}
        </InlineAlert>
      ) : null}
      {unreachable !== '' ? (
        <InlineAlert tone="warning">
          {fill(t('PlatformMailPeople.loginUnreachable'), { addresses: unreachable })}
        </InlineAlert>
      ) : null}
    </>
  );
}

/** PERSONMAIL (ADR-0013). Says in plain words which mailbox the test (and this person's tips) left from. */
function testLine(result: MailPersonTestView, t: ReturnType<typeof useT>): string {
  if (result.route === 'none') return t('PlatformMailPeople.testNoLogin');
  if (!result.sent) return t('PlatformMailPeople.testFailed');
  return fill(t('PlatformMailPeople.testSentOwn'), { address: result.address });
}

const EMPTY: MailPersonInput = {
  nameEn: '',
  nameAr: '',
  roleEn: '',
  roleAr: '',
  address: '',
  languages: 'en',
  region: 'west',
  topic: 'onboarding',
  active: true,
};

function AddPersonDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<MailPersonInput>(EMPTY);
  const set = <K extends keyof MailPersonInput>(key: K, value: MailPersonInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () => addMailPerson(api, draft),
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_MAIL_PEOPLE_QUERY_KEY, view);
      onClose();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <PlatformDialog title={t('PlatformMailPeople.addTitle')} onClose={onClose}>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <Field
          label={t('PlatformMailPeople.colName')}
          value={draft.nameEn}
          maxLength={80}
          required
          onChange={(event) => set('nameEn', event.target.value)}
        />
        <Field
          label={t('PlatformMailPeople.colNameAr')}
          value={draft.nameAr}
          maxLength={80}
          dir="rtl"
          lang="ar"
          required
          onChange={(event) => set('nameAr', event.target.value)}
        />
        <Field
          label={t('PlatformMailPeople.fieldRoleEn')}
          value={draft.roleEn}
          maxLength={80}
          required
          onChange={(event) => set('roleEn', event.target.value)}
        />
        <Field
          label={t('PlatformMailPeople.fieldRoleAr')}
          value={draft.roleAr}
          maxLength={80}
          dir="rtl"
          lang="ar"
          required
          onChange={(event) => set('roleAr', event.target.value)}
        />
        <Field
          label={t('PlatformMailPeople.colAddress')}
          hint={t('PlatformMailPeople.addressHint')}
          type="email"
          dir="ltr"
          value={draft.address}
          maxLength={190}
          required
          onChange={(event) => set('address', event.target.value)}
        />
        <Select
          label={t('PlatformMailPeople.colLanguages')}
          value={draft.languages}
          onChange={(event) =>
            set('languages', pick(event.target.value, MAIL_PERSON_LANGUAGE_VALUES, 'en'))
          }
        >
          {MAIL_PERSON_LANGUAGE_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(LANGUAGE_LABELS[value])}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformMailPeople.colRegion')}
          value={draft.region}
          onChange={(event) =>
            set('region', pick(event.target.value, MAIL_PERSON_REGION_VALUES, 'west'))
          }
        >
          {MAIL_PERSON_REGION_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(REGION_LABELS[value])}
            </option>
          ))}
        </Select>
        <Select
          label={t('PlatformMailPeople.colTopic')}
          hint={t('PlatformMailPeople.topicHelp')}
          value={draft.topic}
          onChange={(event) =>
            set('topic', pick(event.target.value, MAIL_PERSON_TOPIC_VALUES, 'onboarding'))
          }
        >
          {MAIL_PERSON_TOPIC_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(TOPIC_LABELS[value])}
            </option>
          ))}
        </Select>
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
            {t('PlatformMailPeople.addPerson')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}

function ImportDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const save = useMutation({
    mutationFn: () => importMailPeople(api, csv),
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_MAIL_PEOPLE_QUERY_KEY, view);
      onClose();
    },
  });
  return (
    <PlatformDialog title={t('PlatformMailPeople.importTitle')} onClose={onClose}>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="tm-cc-note">{t('PlatformMailPeople.importBody')}</p>
        <label className="tm-content-textarea">
          <span className="tm-content-textarea__label">{t('PlatformMailPeople.importLabel')}</span>
          <textarea
            value={csv}
            rows={8}
            dir="ltr"
            maxLength={40_000}
            spellCheck={false}
            onChange={(event) => setCsv(event.target.value)}
          />
        </label>
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
            disabled={csv.trim() === ''}
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformMailPeople.importConfirm')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}

function pick<T extends string>(raw: string, list: readonly T[], fallback: T): T {
  return list.find((value) => value === raw) ?? fallback;
}
