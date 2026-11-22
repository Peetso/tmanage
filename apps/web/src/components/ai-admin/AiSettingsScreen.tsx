'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Field,
  InlineAlert,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  StateCapsule,
  Switch,
} from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  AI_SETTINGS_KEY,
  fetchAiSettings,
  updateAiSettings,
  type AiSettingsView,
} from '../../lib/api/ai-settings';
import { getConnectedApps } from '../../lib/api/connected-apps';
import { listPeople } from '../../lib/api/people';
import { useFormCheck } from '../../lib/forms/form-check';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import { useAiText } from '../ai-chat/use-ai-text';
import { CloseIcon } from '../ai-chat/icons';
import { AiAdminTabs } from './AiAdminTabs';
import {
  draftOf,
  isDirty,
  memberCreditsAt,
  patchOf,
  retentionDays,
  shareOptions,
  withScope,
  type AiSettingsDraft,
  type BlockedDraftEntry,
} from './ai-settings-model';
import './ai-admin.css';

/**
 * Control Center › AI › Settings (plan 62-17, Figma G1 v2 786:48751: saved 786:48752, unsaved
 * 786:49916, saved notice 786:50694, field error 786:51477, answers only 787:49285, provider line
 * 787:50065, off 787:50837, loading 787:51782, could not load 787:52370, turn-off confirm
 * 787:53287). The company switch works at once (turning it off asks first); the rest is one form
 * the owner saves. The API is owner only and decides every rule again (IP-2, AR-9).
 */
export function AiSettingsScreen({
  organizationSlug,
  organizationName,
  client,
}: {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
}) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const tOr = useTOr();
  const { t } = useAiText();
  const settings = useQuery({
    queryKey: AI_SETTINGS_KEY(organizationSlug),
    queryFn: () => fetchAiSettings(api, organizationSlug),
    retry: false,
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="ai"
      crumbs={[tOr(ccKey('ControlCenter.ai'), 'AI')]}
      title={t('AiSettings.title')}
      description={t('AiSettings.lead')}
      client={api}
    >
      <AiAdminTabs organizationSlug={organizationSlug} current="settings" />
      {settings.isPending ? (
        <div className="tm-ais-set" aria-busy="true">
          <p className="tm-visually-hidden" role="status">
            {t('AiSettings.loading')}
          </p>
          <Skeleton height="var(--s24)" />
          <Skeleton height="var(--s24)" />
        </div>
      ) : null}
      {settings.isError ? (
        <LoadProblem error={settings.error} onRetry={() => void settings.refetch()} />
      ) : null}
      {settings.isSuccess ? (
        <SettingsBody api={api} organizationSlug={organizationSlug} view={settings.data} />
      ) : null}
    </ControlCenterShell>
  );
}

function LoadProblem({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useAiText();
  if (error instanceof ApiRequestError && error.status === 404) {
    return <InlineAlert tone="neutral">{t('AiSettings.notAvailable')}</InlineAlert>;
  }
  if (error instanceof ApiRequestError && error.status === 403) {
    return <InlineAlert tone="neutral">{t('AiSettings.ownerOnly')}</InlineAlert>;
  }
  return (
    <InlineAlert tone="danger" title={t('AiSettings.loadError')} live>
      {error instanceof NetworkError ? t('AiSettings.offline') : t('AiSettings.loadErrorBody')}{' '}
      <Button type="button" tone="text" size="compact" onClick={onRetry}>
        {t('AiSettings.retry')}
      </Button>
    </InlineAlert>
  );
}

function SettingsBody({
  api,
  organizationSlug,
  view,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly view: AiSettingsView;
}) {
  const { t } = useAiText();
  const queries = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const switchRef = useRef<HTMLDivElement>(null);
  const toggle = useMutation({
    mutationFn: (aiEnabled: boolean) => updateAiSettings(api, organizationSlug, { aiEnabled }),
    onSuccess: (next) => {
      queries.setQueryData(AI_SETTINGS_KEY(organizationSlug), next);
      setConfirmOff(false);
      setNotice(t(next.aiEnabled ? 'AiSettings.turnedOn' : 'AiSettings.turnedOff'));
    },
  });

  return (
    <div className="tm-ais-set">
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      <div className="tm-ais-set__cards">
        <section className="tm-ais-set__card" aria-labelledby="ai-set-company">
          <h2 id="ai-set-company" className="tm-ais-set__title">
            {t('AiSettings.company.title')}
          </h2>
          <div ref={switchRef}>
            <Switch
              label={t(view.aiEnabled ? 'AiSettings.company.on' : 'AiSettings.company.off')}
              hint={t('AiSettings.company.note')}
              checked={view.aiEnabled}
              disabled={toggle.isPending}
              onChange={() => {
                if (view.aiEnabled) setConfirmOff(true);
                else toggle.mutate(true);
              }}
            />
          </div>
          {toggle.isError && !confirmOff ? (
            <InlineAlert tone="danger" live>
              {t('AiSettings.saveError')}
            </InlineAlert>
          ) : null}
        </section>
        <OwnAiCard api={api} organizationSlug={organizationSlug} />
      </div>
      <p className="tm-aia-muted">
        {t(
          view.providers.includes('voyage')
            ? 'AiSettings.providersWithVoyage'
            : 'AiSettings.providers',
        )}
      </p>
      {view.aiEnabled ? (
        <SettingsForm
          key={view.updatedAt ?? 'new'}
          api={api}
          organizationSlug={organizationSlug}
          view={view}
          onSaved={() => setNotice(t('AiSettings.saved'))}
          onEdit={() => setNotice(null)}
        />
      ) : null}
      {confirmOff ? (
        <AiDialog
          title={t('AiSettings.off.title')}
          onClose={() => {
            setConfirmOff(false);
            switchRef.current?.querySelector('input')?.focus();
          }}
        >
          <p className="tm-ais-set__text">
            {t('AiSettings.off.body', { days: view.conversationRetentionDays })}
          </p>
          {toggle.isError ? (
            <InlineAlert tone="danger" live>
              {t('AiSettings.saveError')}
            </InlineAlert>
          ) : null}
          <div className="tm-ais-set__actions">
            <Button
              type="button"
              tone="destructive"
              loading={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              {t('AiSettings.off.confirm')}
            </Button>
            <span className="tm-aia-spacer" />
            <Button
              type="button"
              tone="text"
              onClick={() => {
                setConfirmOff(false);
                switchRef.current?.querySelector('input')?.focus();
              }}
            >
              {t('AiSettings.off.keep')}
            </Button>
          </div>
        </AiDialog>
      ) : null}
    </div>
  );
}

/** "Your own AI": the member's own MCP connection, managed under Connected apps. */
function OwnAiCard({
  api,
  organizationSlug,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
}) {
  const { t } = useAiText();
  const apps = useQuery({
    queryKey: ['connected-apps', organizationSlug],
    queryFn: () => getConnectedApps(api, organizationSlug),
    retry: false,
  });
  const mine = apps.data?.apps.find((app) => app.mine) ?? null;
  return (
    <section className="tm-ais-set__card" aria-labelledby="ai-set-own">
      <h2 id="ai-set-own" className="tm-ais-set__title">
        {t('AiSettings.own.title')}
      </h2>
      <div className="tm-ais-set__line">
        <span className="tm-ais-set__text">
          {mine ? t('AiSettings.own.through', { name: mine.clientName }) : t('AiSettings.own.none')}
        </span>
        {mine ? <StateCapsule state="done">{t('AiSettings.own.connected')}</StateCapsule> : null}
        <span className="tm-aia-spacer" />
        <Link
          href={`/${encodeURIComponent(organizationSlug)}/settings/connected-apps`}
          className="tm-button tm-button--text tm-button--compact"
        >
          {t(mine ? 'AiSettings.own.manage' : 'AiSettings.own.connect')}
        </Link>
      </div>
      <p className="tm-aia-muted">{t('AiSettings.own.note')}</p>
    </section>
  );
}

function SettingsForm({
  api,
  organizationSlug,
  view,
  onSaved,
  onEdit,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly view: AiSettingsView;
  readonly onSaved: () => void;
  readonly onEdit: () => void;
}) {
  const { t, number, day } = useAiText();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<AiSettingsDraft>(() => draftOf(view));
  const [blocking, setBlocking] = useState(false);
  const blockButton = useRef<HTMLSpanElement>(null);
  const focusBlock = () => blockButton.current?.querySelector('button')?.focus();
  const check = useFormCheck({
    messages: { retention: t('AiSettings.form.retentionError') },
  });
  const dirty = isDirty(view, draft);
  const days = retentionDays(draft.retention);
  const retentionError =
    days === null && draft.retention.trim() !== ''
      ? t('AiSettings.form.retentionError')
      : check.error('retention');
  const save = useMutation({
    mutationFn: () => updateAiSettings(api, organizationSlug, patchOf(view, draft)),
    onSuccess: (next) => {
      queries.setQueryData(AI_SETTINGS_KEY(organizationSlug), next);
      onSaved();
    },
  });

  function change(next: AiSettingsDraft) {
    setDraft(next);
    onEdit();
  }

  const options = shareOptions(view);
  return (
    <>
      <form
        noValidate
        className="tm-ais-set__card"
        aria-labelledby="ai-set-scope"
        {...check.handlers(() => {
          if (dirty && days !== null && !save.isPending) save.mutate();
        })}
      >
        <h2 id="ai-set-scope" className="tm-ais-set__title">
          {t('AiSettings.form.title')}
        </h2>
        <RadioGroup legend={t('AiSettings.form.title')} className="tm-ais-set__legendless">
          <Radio
            label={t('AiSettings.form.readOnly')}
            checked={draft.writeScope === 'read'}
            onChange={() => change(withScope(draft, 'read'))}
          />
          <Radio
            label={t('AiSettings.form.readWrite')}
            checked={draft.writeScope === 'read_write'}
            onChange={() => change(withScope(draft, 'read_write'))}
          />
        </RadioGroup>
        <hr className="tm-aia-divider" />
        <Checkbox
          label={t('AiSettings.form.runAtOnce')}
          checked={draft.runAtOnce}
          disabled={draft.writeScope === 'read'}
          {...(draft.writeScope === 'read' ? { hint: t('AiSettings.form.runAtOnceNeeds') } : {})}
          onChange={(event) => change({ ...draft, runAtOnce: event.target.checked })}
        />
        <Checkbox
          label={t('AiSettings.form.fileReading')}
          checked={draft.fileReading}
          onChange={(event) => change({ ...draft, fileReading: event.target.checked })}
        />
        <hr className="tm-aia-divider" />
        <div className="tm-ais-set__fields">
          <Select
            label={t('AiSettings.form.share')}
            name="share"
            value={String(draft.memberSharePercent)}
            hint={t('AiSettings.form.shareHint', {
              member: number(memberCreditsAt(view, draft.memberSharePercent)),
              total: number(view.credits.workspaceCredits),
            })}
            onChange={(event) =>
              change({ ...draft, memberSharePercent: Number(event.target.value) })
            }
          >
            {options.map((percent) => (
              <option key={percent} value={percent}>
                {t('AiSettings.form.shareOption', { percent: number(percent) })}
              </option>
            ))}
          </Select>
          <Field
            label={t('AiSettings.form.retention')}
            name="retention"
            inputMode="numeric"
            dir="ltr"
            autoComplete="off"
            required
            value={draft.retention}
            hint={t('AiSettings.form.retentionHint')}
            onChange={(event) => change({ ...draft, retention: event.target.value })}
            {...(retentionError === undefined ? {} : { error: retentionError })}
          />
        </div>
        <hr className="tm-aia-divider" />
        <div className="tm-ais-set__line">
          <h3 className="tm-ais-set__subtitle">{t('AiSettings.blocked.title')}</h3>
          <span className="tm-aia-spacer" />
          <span ref={blockButton}>
            <Button
              type="button"
              tone="outline"
              size="compact"
              className="tm-ais-set__touch"
              onClick={() => setBlocking(true)}
            >
              {t('AiSettings.blocked.add')}
            </Button>
          </span>
        </div>
        {draft.blocked.length === 0 ? (
          <p className="tm-aia-muted">{t('AiSettings.blocked.empty')}</p>
        ) : (
          <ul className="tm-ais-set__blocked">
            {draft.blocked.map((entry) => (
              <li key={entry.membershipId} className="tm-ais-set__member">
                <span className="tm-ais-set__avatar" aria-hidden="true">
                  {initials(entry.displayName)}
                </span>
                <span className="tm-ais-set__who">
                  <span className="tm-ais-set__text">{entry.displayName}</span>
                  <span className="tm-aia-muted">
                    {entry.blockedAt
                      ? t('AiSettings.blocked.since', { date: day(entry.blockedAt) })
                      : t('AiSettings.blocked.pending')}
                  </span>
                </span>
                <Button
                  type="button"
                  tone="text"
                  size="compact"
                  className="tm-ais-set__touch"
                  aria-label={t('AiSettings.blocked.allowFor', { name: entry.displayName })}
                  onClick={() =>
                    change({
                      ...draft,
                      blocked: draft.blocked.filter(
                        (row) => row.membershipId !== entry.membershipId,
                      ),
                    })
                  }
                >
                  {t('AiSettings.blocked.allow')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {save.isError ? (
          <InlineAlert tone="danger" live>
            {save.error instanceof ApiRequestError && save.error.status === 400
              ? save.error.message
              : t('AiSettings.saveError')}
          </InlineAlert>
        ) : null}
        <div className="tm-ais-set__actions">
          <p className="tm-aia-muted" role="status">
            {dirty ? t('AiSettings.form.unsaved') : ''}
          </p>
          <span className="tm-aia-spacer" />
          <Button
            type="button"
            tone="text"
            disabled={!dirty || save.isPending}
            onClick={() => change(draftOf(view))}
          >
            {t('AiSettings.form.cancel')}
          </Button>
          <Button type="submit" tone="ink" disabled={!dirty} loading={save.isPending}>
            {t('AiSettings.form.save')}
          </Button>
        </div>
      </form>
      {blocking ? (
        <BlockMemberDialog
          api={api}
          organizationSlug={organizationSlug}
          blocked={draft.blocked}
          onPick={(entry) => {
            change({ ...draft, blocked: [...draft.blocked, entry] });
            setBlocking(false);
            focusBlock();
          }}
          onClose={() => {
            setBlocking(false);
            focusBlock();
          }}
        />
      ) : null}
    </>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

/** Find a member by name and add them to the blocked list (saved with the form). */
function BlockMemberDialog({
  api,
  organizationSlug,
  blocked,
  onPick,
  onClose,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly blocked: readonly BlockedDraftEntry[];
  readonly onPick: (entry: BlockedDraftEntry) => void;
  readonly onClose: () => void;
}) {
  const { t } = useAiText();
  const [search, setSearch] = useState('');
  const query = search.trim();
  const people = useQuery({
    queryKey: ['ai-settings', organizationSlug, 'people', query],
    queryFn: () => listPeople(api, organizationSlug, { q: query, limit: 20 }),
    enabled: query.length >= 2,
    retry: false,
  });
  const taken = new Set(blocked.map((entry) => entry.membershipId));
  const found = (people.data?.people ?? []).filter((person) => !taken.has(person.membershipId));
  return (
    <AiDialog title={t('AiSettings.blocked.dialogTitle')} onClose={onClose}>
      <Field
        label={t('AiSettings.blocked.search')}
        type="search"
        name="search"
        autoComplete="off"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {query.length >= 2 && people.isSuccess && found.length === 0 ? (
        <p className="tm-aia-muted">{t('AiSettings.blocked.none')}</p>
      ) : null}
      {found.length > 0 ? (
        <ul className="tm-ais-set__blocked">
          {found.slice(0, 8).map((person) => (
            <li key={person.membershipId} className="tm-ais-set__member">
              <span className="tm-ais-set__who">
                <span className="tm-ais-set__text">{person.displayName}</span>
                {person.roleName ? <span className="tm-aia-muted">{person.roleName}</span> : null}
              </span>
              <Button
                type="button"
                tone="outline"
                size="compact"
                className="tm-ais-set__touch"
                aria-label={t('AiSettings.blocked.blockFor', { name: person.displayName })}
                onClick={() =>
                  onPick({
                    membershipId: person.membershipId,
                    displayName: person.displayName,
                    blockedAt: null,
                  })
                }
              >
                {t('AiSettings.blocked.block')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </AiDialog>
  );
}

/** A small modal for the two dialogs here: labelled, Escape closes, focus starts inside. */
function AiDialog({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useAiText();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, button:not([data-close])')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="tm-command-palette__backdrop tm-aia-backdrop">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-aia-editor"
      >
        <div className="tm-aia-editor__head">
          <h2 id={titleId} className="tm-aia-editor__title">
            {title}
          </h2>
          <button
            type="button"
            data-close
            className="tm-aia-icon-button"
            aria-label={t('AiSettings.close')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
