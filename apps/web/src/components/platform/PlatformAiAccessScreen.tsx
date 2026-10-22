'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Field,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  Switch,
  VisuallyHidden,
} from '@tmanage/ui';
import { PlatformShell } from './PlatformShell';
import { PLATFORM_ME_KEY } from './PlatformAdminScreens';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  PLATFORM_AI_ACCESS_ACTIONS,
  fetchPlatformMe,
  fetchPlatformSettings,
  listPlatformAudit,
  setPlatformAiAccess,
} from '../../lib/api/platform-admin';
import type { PlatformAuditEventView, PlatformMeView } from '../../lib/api/platform-admin';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

/**
 * AI access (`/platform/ai-access`, OPS-2..5) — the operator's platform-wide AI kill switch.
 *
 * - OPS-2 on: the black PLATFORM CONTROL card with the switch and who last changed it.
 * - OPS-3 confirm: turning it off (or on) opens a dialog that needs a reason, which the API
 *   writes to the platform audit log; a lapsed password confirmation (403
 *   `reauthentication_required`) sends the operator back to the existing step-up.
 * - OPS-4 off: a red notice above the card.
 * - OPS-5 locked: `TMANAGE_MCP_DISABLED=1` on the server — the switch is disabled and says why.
 *
 * The figure tiles of the design are not shown: the overview API returns no AI counts, and the
 * screen never invents numbers. "Recent changes" is the platform audit log filtered to the two
 * AI-access actions.
 */

type AiKey = `AiAccess.${string}`;
type Translate = (key: AiKey) => string;

/** The P10 keys ship in the i18n-P10 fragment until they are merged into the catalogs. */
function useAiT(): Translate {
  const t = useT();
  return (key) => t(key as MessageKey);
}

const SETTINGS_KEY = ['platform', 'settings'] as const;
const AUDIT_KEY = ['platform', 'audit'] as const;

export interface PlatformAiAccessScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AiAccess.apiNoAnswer');
  return t('AiAccess.genericError');
}

function isStepUpLapse(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'reauthentication_required';
}

function Loading({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="tm-stack tm-stack--tight">
      <Skeleton height="var(--row)" />
      <Skeleton height="var(--row)" />
    </LoadingRegion>
  );
}

export function PlatformAiAccessScreen({ client }: PlatformAiAccessScreenProps) {
  const api = client ?? browserApiClient();
  const t = useAiT();
  const me = useQuery({
    queryKey: PLATFORM_ME_KEY,
    queryFn: () => fetchPlatformMe(api),
    retry: false,
    refetchInterval: 60_000,
  });

  if (me.isError && me.error instanceof ApiRequestError && me.error.status === 404) {
    return (
      <PlatformShell
        section="ai-access"
        crumbs={[t('AiAccess.notFound')]}
        title={t('AiAccess.pageNotFound')}
      >
        <InlineAlert tone="neutral" title={t('AiAccess.pageDoesNotExist')}>
          <Link href="/organizations">{t('AiAccess.backToOrganizations')}</Link>
        </InlineAlert>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell
      section="ai-access"
      crumbs={[t('AiAccess.crumb')]}
      title={t('AiAccess.title')}
      description={t('AiAccess.intro')}
    >
      {me.isPending ? <Loading label={t('AiAccess.checkingAccess')} /> : null}
      {me.isError ? (
        <InlineAlert tone="danger" title={t('AiAccess.couldNotOpen')} live>
          {describe(me.error, t)}
        </InlineAlert>
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt === null ? (
        <InlineAlert tone="warning" title={t('AiAccess.confirmFirstTitle')}>
          {t('AiAccess.confirmFirstBody')}{' '}
          <Link href="/platform">{t('AiAccess.confirmFirstLink')}</Link>
        </InlineAlert>
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt !== null ? (
        <AiAccessBody api={api} me={me.data} />
      ) : null}
    </PlatformShell>
  );
}

function AiAccessBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useAiT();
  const fmt = useDisplayFormatters();
  const [confirming, setConfirming] = useState(false);
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => fetchPlatformSettings(api) });
  const audit = useQuery({ queryKey: AUDIT_KEY, queryFn: () => listPlatformAudit(api) });

  if (settings.isPending) return <Loading label={t('AiAccess.loading')} />;
  if (settings.isError) {
    return (
      <InlineAlert tone="danger" title={t('AiAccess.couldNotLoad')} live>
        {describe(settings.error, t)}
      </InlineAlert>
    );
  }

  const { on, environmentDisabled } = settings.data.aiAccess;
  const changes: readonly PlatformAuditEventView[] = (audit.data ?? [])
    .filter((event) => (PLATFORM_AI_ACCESS_ACTIONS as readonly string[]).includes(event.action))
    .slice(0, 3);
  const last = changes[0];
  const when = (iso: string) => fmt.dateTime(iso, { dateStyle: 'medium', timeStyle: 'short' });
  const turnedOn = (event: PlatformAuditEventView) => event.action === 'platform.ai_access_on';

  const switchStyle: CSSProperties = on
    ? { background: 'var(--lime-500)', borderColor: 'var(--lime-500)' }
    : { background: 'var(--tm-inverted-line)', borderColor: 'var(--tm-inverted-line)' };

  return (
    <div className="tm-cc-column">
      {!on && !environmentDisabled ? (
        <section
          className="tm-cc-card"
          style={{ borderColor: 'var(--danger-600)' }}
          aria-labelledby="tm-ai-access-off-heading"
        >
          <h2
            id="tm-ai-access-off-heading"
            className="tm-cc-card__title"
            style={{ color: 'var(--danger-600)' }}
          >
            {t('AiAccess.offTitle')}
          </h2>
          <p className="tm-cc-card__body">{t('AiAccess.offBody')}</p>
        </section>
      ) : null}

      {environmentDisabled ? <p className="tm-cc-eyebrow">{t('AiAccess.sectionLabel')}</p> : null}
      <section
        className="tm-cc-card tm-cc-card--ink tm-cc-hero"
        aria-labelledby="tm-ai-access-control-heading"
      >
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">{t('AiAccess.platformControl')}</p>
          <h2 id="tm-ai-access-control-heading" className="tm-cc-card__lead">
            {t('AiAccess.controlTitle')}
          </h2>
          {environmentDisabled ? (
            <p className="tm-cc-card__body">{t('AiAccess.lockedBody')}</p>
          ) : (
            <>
              <p className="tm-cc-card__body">{t('AiAccess.controlBody')}</p>
              {last ? (
                <p className="tm-cc-card__body" data-testid="ai-access-last-change">
                  {t('AiAccess.lastChangedBy')} {last.actorEmail} · {when(last.occurredAt)} ·{' '}
                  {turnedOn(last) ? t('AiAccess.turnedOnLower') : t('AiAccess.turnedOffLower')}
                </p>
              ) : null}
            </>
          )}
        </div>
        <Switch
          label={<VisuallyHidden>{t('AiAccess.controlTitle')}</VisuallyHidden>}
          checked={on && !environmentDisabled}
          disabled={environmentDisabled}
          onChange={() => setConfirming(true)}
          style={environmentDisabled ? undefined : switchStyle}
        />
      </section>

      {changes.length > 0 ? (
        <>
          <p className="tm-cc-eyebrow">{t('AiAccess.recentChanges')}</p>
          <section className="tm-cc-card" aria-label={t('AiAccess.recentChanges')}>
            <ul className="tm-cc-rows">
              {changes.map((event) => (
                <li key={event.id}>
                  <span className="tm-cc-card__head" style={{ justifyContent: 'flex-start' }}>
                    <span
                      className={`tm-cc-pill ${turnedOn(event) ? 'tm-cc-pill--on' : 'tm-cc-pill--danger'}`}
                    >
                      {turnedOn(event)
                        ? `✓ ${t('AiAccess.turnedOn')}`
                        : `⚠ ${t('AiAccess.turnedOff')}`}
                    </span>
                    <span className="tm-cc-card__title">{event.actorEmail}</span>
                  </span>
                  <span className="tm-cc-recent__when">
                    {when(event.occurredAt)} · {t('AiAccess.reasonPrefix')} {event.reason}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {confirming && !environmentDisabled ? (
        <ConfirmDialog api={api} me={me} turnOn={!on} onClose={() => setConfirming(false)} />
      ) : null}
    </div>
  );
}

/** OPS-3: the reason dialog. Turning off is the red path; turning back on is the ink one. */
function ConfirmDialog({
  api,
  me,
  turnOn,
  onClose,
}: {
  api: ApiClient;
  me: PlatformMeView;
  turnOn: boolean;
  onClose: () => void;
}) {
  const t = useAiT();
  const queryClient = useQueryClient();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const action = useMutation({
    mutationFn: () => setPlatformAiAccess(api, turnOn, reason.trim()),
    onSuccess: async (settings) => {
      queryClient.setQueryData(SETTINGS_KEY, settings);
      await queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      onClose();
    },
    onError: async (error) => {
      // A lapsed confirmation: `me` now reports no step-up, which shows the way to the form.
      if (isStepUpLapse(error)) await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_KEY });
    },
  });

  useEffect(() => {
    panel.current?.querySelector('input')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirmedMinutesAgo =
    me.stepUpExpiresAt === null
      ? null
      : Math.max(
          0,
          Math.round(
            me.stepUpMinutes - (new Date(me.stepUpExpiresAt).getTime() - Date.now()) / 60_000,
          ),
        );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 5) return;
    action.mutate();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--s4)',
        background: 'color-mix(in srgb, var(--ink-950) 45%, transparent)',
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-cc-card"
        style={{ inlineSize: 'min(560px, 100%)' }}
      >
        <form className="tm-stack" onSubmit={submit}>
          <h2 id={titleId} className="tm-cc-card__title">
            {turnOn ? t('AiAccess.confirmOnTitle') : t('AiAccess.confirmOffTitle')}
          </h2>
          <p className="tm-cc-card__body">
            {turnOn ? t('AiAccess.confirmOnBody') : t('AiAccess.confirmOffBody')}
          </p>
          <Field
            label={t('AiAccess.reasonLabel')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            maxLength={500}
            required
          />
          <p className="tm-cc-recent__when" style={{ textTransform: 'none' }}>
            {confirmedMinutesAgo === null
              ? t('AiAccess.passwordNeeded')
              : `${t('AiAccess.confirmedPrefix')} ${confirmedMinutesAgo} ${t('AiAccess.confirmedSuffix')}`}
          </p>
          {action.isError ? (
            <InlineAlert
              tone="danger"
              title={
                isStepUpLapse(action.error) ? t('AiAccess.stepUpLapsed') : t('AiAccess.notDone')
              }
              live
            >
              {describe(action.error, t)}
            </InlineAlert>
          ) : null}
          <div className="tm-cc-card__actions" style={{ justifyContent: 'flex-end' }}>
            <Button type="button" tone="outline" onClick={onClose}>
              {t('AiAccess.cancel')}
            </Button>
            <Button
              type="submit"
              tone={turnOn ? 'ink' : 'destructive'}
              loading={action.isPending}
              loadingLabel={t('AiAccess.working')}
              disabled={reason.trim().length < 5}
            >
              {turnOn ? t('AiAccess.turnOnConfirm') : t('AiAccess.turnOffConfirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
