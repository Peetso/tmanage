'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserApiClient } from '../../../lib/api/browser-client';
import { ApiRequestError } from '../../../lib/api/errors';
import { fetchOrganizationSupportSession } from '../../../lib/api/organizations';
import {
  SUPPORT_WARNING_SECONDS,
  extendSupportSession,
  supportSessionActivityHref,
} from '../../../lib/api/platform-support';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformDialog } from '../shared/ReasonDialog';
import { StepUpForm } from '../shared/platform-kit';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { SupportExitDialog } from './SupportExitDialog';
import { rememberSupportSession, supportSessionQueryKey } from './support-session-memory';
import './support-mode.css';

export type SupportBannerState = 'live' | 'warning' | 'ended';

/** Red while it runs, amber under five minutes, grey once the time is up (A8). */
export function supportBannerState(remainingSeconds: number): SupportBannerState {
  if (remainingSeconds <= 0) return 'ended';
  if (remainingSeconds < SUPPORT_WARNING_SECONDS) return 'warning';
  return 'live';
}

/** `1:58:12` over an hour, `04:12` under it (437:18252 / 437:18480). */
export function formatSupportClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface SupportModeBannerViewProps {
  organizationName: string;
  adminEmail: string;
  sessionId: string;
  remainingSeconds: number;
  actionsCount: number;
  extending?: boolean;
  onExtend: () => void;
  onExit: () => void;
}

/** The banner itself, without data: easy to test and to show in a story. Never dismissible. */
export function SupportModeBannerView({
  organizationName,
  adminEmail,
  sessionId,
  remainingSeconds,
  actionsCount,
  extending = false,
  onExtend,
  onExit,
}: SupportModeBannerViewProps) {
  const t = useT();
  const state = supportBannerState(remainingSeconds);
  if (state === 'ended') {
    return (
      <div className="tm-support-banner" data-state="ended" role="status">
        <span className="tm-support-banner__badge">{t('SupportMode.badgeEnded')}</span>
        <p className="tm-support-banner__text">
          {t('SupportMode.endedText').replace('{org}', organizationName)}
        </p>
        <div className="tm-support-banner__meta">
          <a className="tm-support-banner__button" href="/platform">
            {t('SupportMode.openPlatform')}
          </a>
        </div>
      </div>
    );
  }
  const clock = formatSupportClock(remainingSeconds);
  return (
    <div
      className="tm-support-banner"
      data-state={state}
      role="region"
      aria-label={t('SupportMode.badge')}
    >
      <span className="tm-support-banner__badge">{t('SupportMode.badge')}</span>
      <p className="tm-support-banner__text">
        {t('SupportMode.bannerText')
          .replace('{org}', organizationName)
          .replace('{admin}', adminEmail)}
      </p>
      <div className="tm-support-banner__meta">
        <span className="tm-support-banner__clock" aria-live="off">
          {(state === 'warning' ? t('SupportMode.endsIn') : t('SupportMode.expiresIn')).replace(
            '{time}',
            clock,
          )}
        </span>
        {state === 'warning' ? (
          <button
            type="button"
            className="tm-support-banner__button"
            onClick={onExtend}
            disabled={extending}
          >
            {t('SupportMode.extend')}
          </button>
        ) : (
          <a className="tm-support-banner__link" href={supportSessionActivityHref(sessionId)}>
            {t('SupportMode.viewActions').replace('{count}', String(actionsCount))}
          </a>
        )}
        <button type="button" className="tm-support-banner__button" onClick={onExit}>
          {t('SupportMode.exit')}
        </button>
      </div>
    </div>
  );
}

/** A lapsed step-up on Extend: the platform step-up form in a dialog, then Extend again. */
function ExtendStepUpDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const api = browserApiClient();
  const permissions = usePlatformPermissions(api);
  return (
    <PlatformDialog title={t('SupportMode.stepUpTitle')} onClose={onClose}>
      <p className="tm-cc-note">{t('SupportMode.stepUpBody')}</p>
      {permissions.me ? <StepUpForm api={api} me={permissions.me} /> : null}
    </PlatformDialog>
  );
}

/**
 * The live banner above the top bar (SPEC A8): the organization's own read of its Support session,
 * refreshed every 30 s, with a per-second countdown. Renders nothing when no support is inside.
 */
export function SupportModeBanner({
  organizationSlug,
  organizationName,
}: {
  organizationSlug: string;
  organizationName: string;
}) {
  const queryClient = useQueryClient();
  const api = browserApiClient();
  const session = useQuery({
    queryKey: ['support', 'organization', organizationSlug],
    queryFn: () => fetchOrganizationSupportSession(api, organizationSlug),
    refetchInterval: 30_000,
    retry: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [exiting, setExiting] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const live = session.data ?? null;

  useEffect(() => {
    if (!live) return undefined;
    rememberSupportSession(organizationSlug, live.id);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, organizationSlug]);

  const remaining = live ? Math.floor((new Date(live.expiresAt).getTime() - now) / 1000) : 0;
  const ended = live !== null && remaining <= 0;
  useEffect(() => {
    // The time ran out on this screen: the ended gate re-reads the session at once.
    if (ended && live) {
      void queryClient.invalidateQueries({ queryKey: supportSessionQueryKey(live.id) });
    }
  }, [ended, live, queryClient]);

  const extend = useMutation({
    mutationFn: (id: string) => extendSupportSession(api, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['support'] });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        setStepUp(true);
      }
    },
  });

  if (!live) return null;
  return (
    <>
      <SupportModeBannerView
        organizationName={organizationName}
        adminEmail={live.adminEmail}
        sessionId={live.id}
        remainingSeconds={remaining}
        actionsCount={live.actionsCount}
        extending={extend.isPending}
        onExtend={() => extend.mutate(live.id)}
        onExit={() => setExiting(true)}
      />
      {exiting ? (
        <SupportExitDialog
          sessionId={live.id}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          actionsCount={live.actionsCount}
          startedAt={live.startedAt}
          onClose={() => setExiting(false)}
        />
      ) : null}
      {stepUp ? <ExtendStepUpDialog onClose={() => setStepUp(false)} /> : null}
    </>
  );
}
