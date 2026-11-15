'use client';

import Link from 'next/link';
import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import { listPortalSignatureRequests } from '../../../lib/api/esign';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { Tag } from '../PortalParts';
import { useEsignT } from './esign-copy';
import '../../../styles/screens/esign.css';

/**
 * 52-26: "Waiting for your signature" on the portal's deliverables (Approvals) page — one card
 * per pending request addressed to the signed-in client. Renders nothing when there is none.
 */
export function PortalSignatureWaitingList({
  api,
  organizationSlug,
}: {
  api: ApiClient;
  organizationSlug: string;
}) {
  const t = useEsignT();
  const fmt = useDisplayFormatters();
  const headingId = useId();
  const list = useQuery({
    queryKey: ['portal-signatures', organizationSlug],
    queryFn: () => listPortalSignatureRequests(api, organizationSlug),
    retry: false,
  });
  const pending = (list.data?.requests ?? []).filter((request) => request.state === 'pending');
  if (pending.length === 0) return null;

  return (
    <section className="tm-stack" aria-labelledby={headingId}>
      <h2 id={headingId} className="tm-pt-eyebrow">
        {t('waitingListTitle')}
      </h2>
      <ul className="tm-pt-grid">
        {pending.map((request) => {
          const href = `/${organizationSlug}/portal/sign/${encodeURIComponent(request.id)}`;
          return (
            <li key={request.id}>
              <article className="tm-pt-deliv tm-pt-deliv--lead">
                <div className="tm-pt-action__meta">
                  <Tag tone="client">{t('waitingForYou')}</Tag>
                  <span className="tm-pt-mono">
                    {t('waitingCard', { date: fmt.day(request.expiresAt) })}
                  </span>
                </div>
                <h3 className="tm-pt-deliv__title" dir="auto">
                  <Link href={href}>{request.title}</Link>
                </h3>
                <p className="tm-pt-quiet">{request.organizationName}</p>
                <div className="tm-pt-deliv__actions">
                  <Link className="tm-pt-btn tm-pt-btn--lime" href={href}>
                    {t('signNow')}
                  </Link>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
