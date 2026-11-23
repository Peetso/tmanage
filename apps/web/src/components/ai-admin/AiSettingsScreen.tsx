'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
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
  type AiReadiness,
  type AiSettingsView,
} from '../../lib/api/ai-settings';
import { getConnectedApps } from '../../lib/api/connected-apps';
import { listPeople } from '../../lib/api/people';
import { useFormCheck } from '../../lib/forms/form-check';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import { useAiText, type AiTextKey } from '../ai-chat/use-ai-text';
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
 *
 * AI panel pass (2026-11-23): laid out as Figma G1 770:44997 (on) / 770:46185 (off): the Testing
 * badge and lead, "Your own AI" then "TManage AI" (switch in the card), the provider line, the form
 * as one card of rows (two choice rows, row switches, the share select and retention on the
 * right), Save changes and Cancel under it.
 *
 * AI-TWO-WAYS (plan 62 §Decision, Peter 2026-11-23): the two directions are always two cards side
 * by side. "Your own AI" (MCP) never depends on the settings read; "TManage AI for your company"
 * is drawn in every state of it — loaded, not on the test list (404), not the owner (403), loading
 * and could not load — never a lone line in place of both.
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
      titleMeta={<Badge>{t('AiChat.testing')}</Badge>}
      description={t('AiSettings.leadTesting')}
      tabs={<AiAdminTabs organizationSlug={organizationSlug} current="settings" />}
      client={api}
    >
      {settings.isSuccess ? (
        <SettingsBody api={api} organizationSlug={organizationSlug} view={settings.data} />
      ) : (
        // AI-TWO-WAYS: whatever the TManage AI read answers, both directions stay on the page.
        <div className="tm-ais-set">
          <div className="tm-ais-set__cards">
            <OwnAiCard api={api} organizationSlug={organizationSlug} />
            <CompanyCard control={null}>
              {settings.isPending ? (
                <div className="tm-ais-set__loading" aria-busy="true">
                  <p className="tm-visually-hidden" role="status">
                    {t('AiSettings.loading')}
                  </p>
                  <Skeleton height="var(--s6)" />
                  <Skeleton height="var(--s4)" />
                </div>
              ) : (
                <CompanyProblem error={settings.error} onRetry={() => void settings.refetch()} />
              )}
            </CompanyCard>
          </div>
        </div>
      )}
    </ControlCenterShell>
  );
}

/**
 * "TManage AI" (Figma 770:45020): the title with its switch at the far end, what it is, then the
 * state below. The same card in every state of the settings read.
 */
function CompanyCard({
  control,
  credits,
  children,
}: {
  readonly control: ReactNode;
  readonly credits?: number;
  readonly children: ReactNode;
}) {
  const { t, number } = useAiText();
  return (
    <section className="tm-ais-set__card" aria-labelledby="ai-set-company">
      <div className="tm-ais-set__head">
        <h2 id="ai-set-company" className="tm-ais-set__title">
          {t('AiSettings.company.cardTitle')}
        </h2>
        <span className="tm-aia-spacer" />
        {control}
      </div>
      <p className="tm-ais-set__text">
        {credits === undefined
          ? t('AiSettings.company.bodyNoCredits')
          : t('AiSettings.company.body', { credits: number(credits) })}
      </p>
      {children}
    </section>
  );
}

/**
 * The company card when the settings read failed (Figma G1 off 770:46185 / 787:50837, error
 * 770:47104 / 787:52370): 404 = not on the test list (the switch, off and disabled, with why);
 * 403 = not the owner (read only, with who can change it); anything else = could not load, with
 * Try again. The own-AI card beside it never depends on this read.
 */
function CompanyProblem({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useAiText();
  if (error instanceof ApiRequestError && error.status === 404) {
    return (
      <Switch
        label={t('AiSettings.company.offEveryone')}
        hint={t('AiSettings.notAvailable')}
        checked={false}
        disabled
        readOnly
      />
    );
  }
  if (error instanceof ApiRequestError && error.status === 403) {
    return <p className="tm-ais-set__text">{t('AiSettings.ownerOnly')}</p>;
  }
  return (
    <>
      <InlineAlert tone="danger" title={t('AiSettings.loadError')} live>
        {error instanceof NetworkError ? t('AiSettings.offline') : t('AiSettings.loadErrorBody')}
      </InlineAlert>
      <div className="tm-ais-set__actions">
        <Button type="button" tone="outline" size="compact" onClick={onRetry}>
          {t('AiSettings.retry')}
        </Button>
      </div>
    </>
  );
}

/**
 * AI-TWO-WAYS: on, but the chat's own gates would still refuse (the "AI copilot" module off, or
 * no AI key for this workspace's group yet) — said in the card before a member asks.
 */
function ReadinessNotice({
  organizationSlug,
  readiness,
}: {
  readonly organizationSlug: string;
  readonly readiness: AiReadiness;
}) {
  const { t } = useAiText();
  if (readiness === 'ready') return null;
  return (
    <InlineAlert tone="neutral">
      {readiness === 'flag_off' ? (
        <>
          {t('AiSettings.readiness.flagOff')}{' '}
          <Link href={`/${encodeURIComponent(organizationSlug)}/admin/feature-flags`}>
            {t('AiSettings.readiness.openFlags')}
          </Link>
        </>
      ) : (
        t('AiSettings.readiness.noKey')
      )}
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
        <OwnAiCard api={api} organizationSlug={organizationSlug} />
        <CompanyCard
          credits={view.credits.workspaceCredits}
          control={
            <div ref={switchRef} className="tm-ais-set__switch">
              <Switch
                label={t('AiSettings.company.switchLabel')}
                checked={view.aiEnabled}
                disabled={toggle.isPending}
                onChange={() => {
                  if (view.aiEnabled) setConfirmOff(true);
                  else toggle.mutate(true);
                }}
              />
            </div>
          }
        >
          {view.aiEnabled ? (
            <Link
              className="tm-ais-set__link"
              href={`/${encodeURIComponent(organizationSlug)}/admin/ai/usage`}
            >
              {t('AiSettings.company.seeUsage')}
            </Link>
          ) : (
            <p className="tm-ais-set__text">{t('AiSettings.company.offEveryone')}</p>
          )}
          {toggle.isError && !confirmOff ? (
            <InlineAlert tone="danger" live>
              {t('AiSettings.saveError')}
            </InlineAlert>
          ) : null}
          <ReadinessNotice organizationSlug={organizationSlug} readiness={view.readiness} />
        </CompanyCard>
      </div>
      {/* Figma 770:45056: one bordered line with an ⓘ glyph; off, it says what switching on opens. */}
      <p className="tm-ais-set__provider">
        <span className="tm-ais-set__provider-glyph" aria-hidden="true">
          ⓘ
        </span>
        <span>
          {view.aiEnabled
            ? t(
                view.providers.includes('voyage')
                  ? 'AiSettings.providerLineVoyage'
                  : 'AiSettings.providerLine',
              )
            : t('AiSettings.offLine')}
        </span>
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

/**
 * "Your own AI" (Figma 770:45001): the member's own assistant over the TManage connector, with
 * "Connected" when one is, and the way to manage or connect it. Never depends on the TManage AI
 * settings read (AI-TWO-WAYS).
 */
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
  const slug = encodeURIComponent(organizationSlug);
  return (
    <section className="tm-ais-set__card" aria-labelledby="ai-set-own">
      <div className="tm-ais-set__head">
        <h2 id="ai-set-own" className="tm-ais-set__title">
          {t('AiSettings.own.title')}
        </h2>
        <span className="tm-aia-spacer" />
        {mine ? (
          <StateCapsule state="done" className="tm-ais-set__capsule">
            {t('AiSettings.own.connected')}
          </StateCapsule>
        ) : null}
      </div>
      <p className="tm-ais-set__text">{t('AiSettings.own.body')}</p>
      <Link
        className="tm-ais-set__link"
        href={mine ? `/${slug}/settings/connected-apps` : `/${slug}/settings/ai-assistant`}
      >
        {t(mine ? 'AiSettings.own.manageConnection' : 'AiSettings.own.pointerLink')}
      </Link>
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
  const { t, number, locale } = useAiText();
  const queries = useQueryClient();
  const retentionId = useId();
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
  const formId = useId();
  const addMember = (
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
  );
  return (
    <>
      <form
        noValidate
        id={formId}
        className="tm-ais-set__card tm-ais-set__form"
        aria-labelledby="ai-set-scope"
        {...check.handlers(() => {
          if (dirty && days !== null && !save.isPending) save.mutate();
        })}
      >
        <RadioGroup
          legend={<span id="ai-set-scope">{t('AiSettings.form.title')}</span>}
          className="tm-ais-set__scope"
        >
          <Radio
            className="tm-ais-set__option"
            label={t('AiSettings.form.readOnly')}
            hint={t('AiSettings.form.readOnlyHint')}
            checked={draft.writeScope === 'read'}
            onChange={() => change(withScope(draft, 'read'))}
          />
          <Radio
            className="tm-ais-set__option"
            label={t('AiSettings.form.readWriteTitle')}
            hint={t('AiSettings.form.readWriteHint')}
            checked={draft.writeScope === 'read_write'}
            onChange={() => change(withScope(draft, 'read_write'))}
          />
        </RadioGroup>
        <Switch
          className="tm-ais-set__row"
          label={t('AiSettings.form.runAtOnceTitle')}
          hint={
            draft.writeScope === 'read'
              ? t('AiSettings.form.runAtOnceNeeds')
              : t('AiSettings.form.runAtOnceHint')
          }
          checked={draft.runAtOnce}
          disabled={draft.writeScope === 'read'}
          onChange={(event) => change({ ...draft, runAtOnce: event.target.checked })}
        />
        <Switch
          className="tm-ais-set__row"
          label={t('AiSettings.form.fileReadingTitle')}
          hint={t('AiSettings.form.fileReadingHint')}
          checked={draft.fileReading}
          onChange={(event) => change({ ...draft, fileReading: event.target.checked })}
        />
        <Select
          className="tm-ais-set__row"
          label={t('AiSettings.form.share')}
          name="share"
          value={String(draft.memberSharePercent)}
          hint={t('AiSettings.form.shareRowHint')}
          onChange={(event) => change({ ...draft, memberSharePercent: Number(event.target.value) })}
        >
          {options.map((percent) => (
            <option key={percent} value={percent}>
              {t('AiSettings.form.shareCredits', {
                percent: number(percent),
                credits: number(memberCreditsAt(view, percent)),
              })}
            </option>
          ))}
        </Select>
        {/* Figma G1 770:45366 / 770:45321: the title alone, then each member (avatar and name)
            with "Allow again" (G1 v2 786:49121), and "Add member" at the end of the first row. */}
        <div className="tm-ais-set__row tm-ais-set__row--list">
          <h3 className="tm-ais-set__subtitle">{t('AiSettings.blocked.title')}</h3>
          {draft.blocked.length === 0 ? (
            <div className="tm-ais-set__member">
              <p className="tm-ais-set__who tm-aia-muted">{t('AiSettings.blocked.empty')}</p>
              {addMember}
            </div>
          ) : (
            <ul className="tm-ais-set__blocked">
              {draft.blocked.map((entry, index) => (
                <li key={entry.membershipId} className="tm-ais-set__member">
                  <span className="tm-ais-set__avatar" aria-hidden="true">
                    {initials(entry.displayName)}
                  </span>
                  <span className="tm-ais-set__who tm-ais-set__text">{entry.displayName}</span>
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
                  {index === 0 ? addMember : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Figma G1 770:45375: the label and help at the start, "30 days" in the field at the end;
            the 1–365 check stays (the server checks it again, AR-9). */}
        <div className="tm-field tm-ais-set__row">
          <label className="tm-field__label" htmlFor={retentionId}>
            {t('AiSettings.form.retentionTitle')}
          </label>
          <div className="tm-field__control tm-ais-set__days">
            <input
              id={retentionId}
              className="tm-ais-set__days-input"
              name="retention"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              required
              value={draft.retention}
              aria-invalid={retentionError === undefined ? undefined : true}
              aria-describedby={
                retentionError === undefined
                  ? `${retentionId}-hint`
                  : `${retentionId}-hint ${retentionId}-error`
              }
              onChange={(event) => change({ ...draft, retention: event.target.value })}
            />
            {/* A second label: the unit is read with the name and a press on it focuses the field. */}
            <label className="tm-ais-set__days-unit" htmlFor={retentionId}>
              {retentionUnit(t, locale, draft.retention, view.conversationRetentionDays)}
            </label>
          </div>
          <span className="tm-field__hint" id={`${retentionId}-hint`}>
            {t('AiSettings.form.retentionRowHint')}
          </span>
          {retentionError === undefined ? null : (
            <span className="tm-field__error" id={`${retentionId}-error`}>
              <span className="tm-inline-alert__glyph" aria-hidden="true">
                !
              </span>
              {retentionError}
            </span>
          )}
        </div>
        {save.isError ? (
          <InlineAlert tone="danger" live>
            {save.error instanceof ApiRequestError && save.error.status === 400
              ? save.error.message
              : t('AiSettings.saveError')}
          </InlineAlert>
        ) : null}
      </form>
      {/* Figma 770:45228: Save changes (Ink) and Cancel under the card, at the start. */}
      <div className="tm-ais-set__actions">
        <Button type="submit" form={formId} tone="ink" disabled={!dirty} loading={save.isPending}>
          {t('AiSettings.form.save')}
        </Button>
        <Button
          type="button"
          tone="text"
          disabled={!dirty || save.isPending}
          onClick={() => change(draftOf(view))}
        >
          {t('AiSettings.form.cancel')}
        </Button>
        <p className="tm-aia-muted" role="status">
          {dirty ? t('AiSettings.form.unsaved') : ''}
        </p>
      </div>
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

/** "days" after the typed number, in the locale's plural form; the saved number while unreadable. */
function retentionUnit(
  t: (key: AiTextKey) => string,
  locale: string,
  typed: string,
  saved: number,
): string {
  const value = /^\d{1,3}$/u.test(typed.trim()) ? Number(typed.trim()) : saved;
  const category = new Intl.PluralRules(locale).select(value);
  const keys = {
    zero: 'AiSettings.form.retentionUnit.zero',
    one: 'AiSettings.form.retentionUnit.one',
    two: 'AiSettings.form.retentionUnit.two',
    few: 'AiSettings.form.retentionUnit.few',
    many: 'AiSettings.form.retentionUnit.many',
    other: 'AiSettings.form.retentionUnit.other',
  } as const satisfies Record<Intl.LDMLPluralRule, AiTextKey>;
  return t(keys[category]);
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
