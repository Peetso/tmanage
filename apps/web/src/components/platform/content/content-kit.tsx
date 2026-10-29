'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  contentHomeHref,
  contentTrashHref,
  fetchContentHome,
  isSupportSessionRequired,
} from '../../../lib/api/platform-content';
import type {
  PlatformContentHomeView,
  PlatformContentRowView,
} from '../../../lib/api/platform-content';
import { fetchPlatformOrg } from '../../../lib/api/platform-organizations';
import {
  endSupportSession,
  startSupportSession,
  SUPPORT_DEFAULT_MINUTES,
  SUPPORT_DURATIONS,
  supportSessionActivityHref,
} from '../../../lib/api/platform-support';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { orgKey } from '../organizations/org-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { formatMoment, PlatformGate } from '../shared/platform-kit';
import { platformErrorText, REASON_MAX, REASON_MIN } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import './content.css';

/** Every PA-08 query starts with this key, so a support session change refetches them all. */
export const CONTENT_KEY = ['platform', 'content'] as const;

export function contentKey(organizationId: string, ...rest: readonly unknown[]) {
  return [...CONTENT_KEY, organizationId, ...rest] as const;
}

const KIND_KEYS: Record<string, MessageKey> = {
  message: 'PlatformContent.kindMessage',
  direct_message: 'PlatformContent.kindDirectMessage',
  work_item: 'PlatformContent.kindWorkItem',
  work_comment: 'PlatformContent.kindComment',
  doc_comment: 'PlatformContent.kindComment',
  decision_comment: 'PlatformContent.kindComment',
  file_comment: 'PlatformContent.kindComment',
  request_comment: 'PlatformContent.kindComment',
  update_comment: 'PlatformContent.kindComment',
  doc: 'PlatformContent.kindDoc',
  decision: 'PlatformContent.kindDecision',
  meeting: 'PlatformContent.kindMeeting',
  file: 'PlatformContent.kindFile',
  drive_file: 'PlatformContent.kindDriveFile',
  onedrive_file: 'PlatformContent.kindOneDriveFile',
  request_message: 'PlatformContent.kindRequestMessage',
};

export function kindLabel(kind: string, t: ReturnType<typeof useT>): string {
  const key = KIND_KEYS[kind];
  return key ? t(key) : kind;
}

/**
 * The B5–B7 frame: the Platform gate (section Content), the organization's content home, and the
 * 428 branch — without a live support session every read is refused, so the inline prompt
 * (436:17010) takes the place of the screen and, once a session opens, the screen refetches in
 * place rather than leaving for the organization.
 */
export function ContentFrame({
  api,
  organizationId,
  title,
  crumb,
  children,
}: {
  api: ApiClient;
  organizationId: string;
  title: (organizationName: string) => string;
  crumb: string;
  children: (home: PlatformContentHomeView, me: PlatformMeView) => ReactNode;
}) {
  const t = useT();
  const home = useQuery({
    queryKey: contentKey(organizationId, 'home'),
    queryFn: () => fetchContentHome(api, organizationId),
    retry: false,
  });
  const needsSession = home.isError && isSupportSessionRequired(home.error);
  const org = useQuery({
    queryKey: orgKey(organizationId),
    queryFn: () => fetchPlatformOrg(api, organizationId),
    retry: false,
    enabled: needsSession,
  });
  const name =
    home.data?.organization.name ?? org.data?.organization.name ?? t('PlatformContent.crumb');
  return (
    <PlatformGate
      api={api}
      section="content"
      crumbs={[t('PlatformContent.crumb'), name, crumb]}
      title={title(name)}
      actions={() =>
        home.isSuccess ? (
          <div className="tm-cc-card__actions">
            <Link className="tm-cc-row-button" href="/platform/organizations">
              {t('PlatformContent.changeOrganization')}
            </Link>
            <Link className="tm-cc-row-button" href={contentTrashHref(organizationId)}>
              {t('PlatformContent.deletedItems')} · {home.data.trashCount}
            </Link>
          </div>
        ) : null
      }
    >
      {(me) => (
        <div className="tm-cc-column">
          {home.isPending ? <PlatformPageState state="loading" /> : null}
          {needsSession ? (
            <SupportSessionPrompt api={api} organizationId={organizationId} name={name} />
          ) : null}
          {home.isError && !needsSession ? (
            <PlatformPageState
              state="error"
              error={home.error}
              onRetry={() => void home.refetch()}
            />
          ) : null}
          {home.isSuccess ? (
            <>
              <SupportStrip api={api} home={home.data} />
              {children(home.data, me)}
            </>
          ) : null}
        </div>
      )}
    </PlatformGate>
  );
}

/**
 * Support session needed (436:17010): reads count as access, so the admin opens a session — 30 min,
 * 2 hours (default) or 8 hours, with an optional reason — and the content loads in place.
 */
export function SupportSessionPrompt({
  api,
  organizationId,
  name,
}: {
  api: ApiClient;
  organizationId: string;
  name: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEnter = usePlatformPermissions(api).has('platform.orgs.enter');
  const [minutes, setMinutes] = useState<number>(SUPPORT_DEFAULT_MINUTES);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const trimmed = reason.trim();
  const invalid =
    trimmed.length > 0 && (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX);
  const open = useMutation({
    mutationFn: () =>
      startSupportSession(api, organizationId, {
        minutes,
        reason: trimmed === '' ? null : trimmed,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKey(organizationId) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (invalid) return;
    open.mutate();
  }

  return (
    <section
      className="tm-cc-card tm-content-prompt"
      aria-labelledby="tm-content-prompt-title"
      data-testid="support-session-needed"
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <p className="tm-cc-eyebrow tm-content-prompt__eyebrow">
          {t('PlatformContent.promptEyebrow')}
        </p>
        <h2 id="tm-content-prompt-title" className="tm-cc-card__title">
          {t('PlatformContent.promptTitle')} {name}
        </h2>
        <p className="tm-cc-note">{t('PlatformContent.promptBody')}</p>
        <fieldset className="tm-content-prompt__durations">
          <legend className="tm-cc-eyebrow">{t('PlatformContent.promptDuration')}</legend>
          <div className="tm-chip-row">
            {SUPPORT_DURATIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={value === minutes ? 'tm-chip tm-chip--active' : 'tm-chip'}
                aria-pressed={value === minutes}
                onClick={() => setMinutes(value)}
              >
                {durationLabel(value, t)}
              </button>
            ))}
          </div>
        </fieldset>
        <Field
          label={t('PlatformShared.reasonOptional')}
          placeholder={t('PlatformContent.promptReasonPlaceholder')}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          {...(tried && invalid ? { error: t('PlatformShared.reasonError') } : {})}
        />
        <InlineAlert tone="neutral">{t('PlatformContent.promptNote')}</InlineAlert>
        {!canEnter ? (
          <InlineAlert tone="warning">{t('PlatformContent.promptNoPermission')}</InlineAlert>
        ) : null}
        {open.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(open.error, t)}
          </InlineAlert>
        ) : null}
        <div className="tm-cc-card__actions">
          <Button
            type="submit"
            tone="destructive"
            disabled={!canEnter}
            loading={open.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformContent.promptOpen')} · {durationShort(minutes, t)}
          </Button>
          <Link className="tm-cc-row-button" href={`/platform/organizations/${organizationId}`}>
            {t('PlatformShared.cancel')}
          </Link>
        </div>
      </form>
    </section>
  );
}

function durationLabel(minutes: number, t: ReturnType<typeof useT>): string {
  if (minutes < 60) return `${minutes} ${t('PlatformContent.minutes')}`;
  return `${minutes / 60} ${t('PlatformContent.hours')}`;
}

function durationShort(minutes: number, t: ReturnType<typeof useT>): string {
  if (minutes < 60) return `${minutes} ${t('PlatformContent.minutesShort')}`;
  return `${minutes / 60} ${t('PlatformContent.hoursShort')}`;
}

/** The red strip over B5–B7: who is in support mode, until when, and the two exits. */
export function SupportStrip({ api, home }: { api: ApiClient; home: PlatformContentHomeView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const end = useMutation({
    mutationFn: () => endSupportSession(api, home.session.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKey(home.organization.id) });
    },
  });
  return (
    <div className="tm-content-strip" role="status" data-testid="content-support-strip">
      <span className="tm-content-strip__badge">{t('PlatformContent.stripBadge')}</span>
      <p className="tm-content-strip__text">
        {t('PlatformContent.stripText')} {home.organization.name} · {home.session.adminEmail} ·{' '}
        {t('PlatformContent.stripEnds')} {formatMoment(home.session.expiresAt)}
      </p>
      <Link className="tm-content-strip__link" href={supportSessionActivityHref(home.session.id)}>
        {t('PlatformContent.viewMyActions')}
      </Link>
      <button
        type="button"
        className="tm-content-strip__end"
        onClick={() => end.mutate()}
        disabled={end.isPending}
      >
        {t('PlatformContent.endSession')}
      </button>
    </div>
  );
}

/** "Removed by TManage support · date" (or by a member), with the reason and Restore. */
export function DeletedNotice({
  row,
  onRestore,
  canRestore,
}: {
  row: PlatformContentRowView;
  onRestore?: () => void;
  canRestore: boolean;
}) {
  const t = useT();
  if (row.deletedAt === null) return null;
  return (
    <div className="tm-content-removed" data-testid="content-removed">
      <span>
        {row.deletedViaSupport
          ? t('PlatformContent.removedBySupport')
          : t('PlatformContent.removedByMember')}{' '}
        · {formatMoment(row.deletedAt)}
        {row.purgeAfter ? ` · ${t('PlatformContent.purges')} ${formatMoment(row.purgeAfter)}` : ''}
      </span>
      {canRestore && onRestore ? (
        <Button type="button" tone="text" size="compact" onClick={onRestore}>
          {t('PlatformContent.restore')}
        </Button>
      ) : null}
    </div>
  );
}

export function homeHref(organizationId: string): string {
  return contentHomeHref(organizationId);
}
