'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { getPortalApprovalRecord } from '../../../lib/api/approval-records';
import {
  portalRecordHref,
  recordSentenceKey,
  shortFingerprint,
  summarizeRecord,
} from '../../../lib/approval-record-presentation';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { Fact } from './ApprovalRecordPanel';

export interface PortalApprovalRecordCardProps {
  api: ApiClient;
  organizationSlug: string;
  deliverableVersionId: string;
  providerName: string;
}

/**
 * 52-19 (Figma 605:34045 "Your approval"): the client's own sealed decision on this version, with
 * the check result and the way to the printable record. Renders nothing until a record exists.
 */
export function PortalApprovalRecordCard({
  api,
  organizationSlug,
  deliverableVersionId,
  providerName,
}: PortalApprovalRecordCardProps) {
  const t = useT();
  const fmt = useDisplayFormatters();
  const record = useQuery({
    queryKey: ['portal-approval-record', organizationSlug, deliverableVersionId],
    queryFn: () => getPortalApprovalRecord(api, organizationSlug, deliverableVersionId),
    retry: false,
  });
  const summary = record.data ? summarizeRecord(record.data) : null;
  const evidence = summary?.decisive?.evidence;
  if (!summary || !evidence) return null;

  const sentence = t(recordSentenceKey(evidence, 'you'))
    .replace('{version}', String(evidence.versionNo))
    .replace('{date}', fmt.dateTime(evidence.decidedAt));

  return (
    <section className="tm-pt-card tm-pt-card--lg tm-arec" aria-labelledby="tm-arec-portal-title">
      <h2 id="tm-arec-portal-title" className="tm-arec__title">
        {t('ApprovalRecord.yourApproval')}
      </h2>
      <p className="tm-arec__text">{sentence}</p>
      <Fact label={t('ApprovalRecord.fingerprintShort')} mono>
        {shortFingerprint(evidence.contentHash)}
      </Fact>
      {summary.status === 'verified' ? (
        <InlineAlert tone="success" title={t('ApprovalRecord.verified')}>
          {t('ApprovalRecord.portalVerifiedBody')}
        </InlineAlert>
      ) : (
        <InlineAlert tone="danger" title={t('ApprovalRecord.changedLabel')}>
          {t('ApprovalRecord.portalChangedBody').replace('{provider}', providerName)}
        </InlineAlert>
      )}
      <p className="tm-arec__muted">
        {t('ApprovalRecord.portalPromise').replace('{provider}', providerName)}
      </p>
      <Link
        className="tm-button tm-button--ink tm-button--accessible tm-pt-btn--block"
        href={portalRecordHref(organizationSlug, deliverableVersionId)}
      >
        {t('ApprovalRecord.viewCertificate')}
      </Link>
    </section>
  );
}
