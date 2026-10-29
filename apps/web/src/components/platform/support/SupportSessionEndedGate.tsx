'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../../lib/api/browser-client';
import { fetchSupportSession, supportSessionActivityHref } from '../../../lib/api/platform-support';
import type { PlatformSupportSessionView } from '../../../lib/api/platform-support';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { SupportModeBannerView } from './SupportModeBanner';
import { rememberedSupportSession, supportSessionQueryKey } from './support-session-memory';
import './support-mode.css';

const CAUSE: Record<string, MessageKey> = {
  expired: 'SupportMode.causeExpired',
  exited: 'SupportMode.causeExited',
  ended_by_admin: 'SupportMode.causeEndedByAdmin',
  signed_out: 'SupportMode.causeSignedOut',
};

function clockTime(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** The ended page (437:18974), without data. */
export function SupportSessionEndedView({ session }: { session: PlatformSupportSessionView }) {
  const t = useT();
  const minutes = Math.round(
    (new Date(session.expiresAt).getTime() - new Date(session.startedAt).getTime()) / 60_000,
  );
  const length =
    minutes % 60 === 0
      ? t('SupportMode.lengthHours').replace('{n}', String(minutes / 60))
      : t('SupportMode.lengthMinutes').replace('{n}', String(minutes));
  const cause = t(CAUSE[session.endedReason ?? 'expired'] ?? 'SupportMode.causeExpired');
  let fact = t('SupportMode.endedFact')
    .replace('{cause}', cause)
    .replace('{count}', String(session.actionsCount));
  if (session.reason) fact += t('SupportMode.endedFactReason').replace('{reason}', session.reason);
  return (
    <div className="tm-support-ended">
      <SupportModeBannerView
        organizationName={session.organizationName}
        adminEmail={session.adminEmail}
        sessionId={session.id}
        remainingSeconds={0}
        actionsCount={session.actionsCount}
        onExtend={() => undefined}
        onExit={() => undefined}
      />
      <main id="tm-main" className="tm-support-ended__body">
        <section className="tm-cc-card tm-stack tm-support-ended__card">
          <h1 className="tm-cc-card__title">
            {t('SupportMode.endedTitle').replace('{org}', session.organizationName)}
          </h1>
          <p className="tm-cc-note">
            {t('SupportMode.endedBody')
              .replace('{length}', length)
              .replace('{time}', clockTime(session.endedAt ?? session.expiresAt))}
          </p>
          <p className="tm-support-ended__fact">
            <span className="tm-support-ended__fact-icon" aria-hidden="true">
              i
            </span>
            <span>{fact}</span>
          </p>
          <div className="tm-support-ended__actions">
            <a className="tm-button tm-button--default tm-button--ink" href="/platform">
              {t('SupportMode.backToPlatform')}
            </a>
            <a
              className="tm-button tm-button--default tm-button--outline"
              href={supportSessionActivityHref(session.id)}
            >
              {t('SupportMode.viewLog')}
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

/**
 * Once the Support session this tab entered with is over (expired, exited elsewhere, ended by
 * another admin), the organization's pages give way to the ended page instead of a run of 403s.
 * Mount only with a `QueryClient` in the tree; renders the children when this tab entered no
 * session or it is still live.
 */
export function SupportSessionEndedGate({
  organizationSlug,
  children,
}: {
  organizationSlug: string;
  children: ReactNode;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(rememberedSupportSession(organizationSlug));
    const timer = window.setInterval(
      () => setSessionId(rememberedSupportSession(organizationSlug)),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, [organizationSlug]);
  const session = useQuery({
    queryKey: supportSessionQueryKey(sessionId ?? ''),
    queryFn: () => fetchSupportSession(browserApiClient(), sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: 30_000,
    retry: false,
  });
  const view = session.data?.session;
  if (view && !view.live) return <SupportSessionEndedView session={view} />;
  return <>{children}</>;
}
