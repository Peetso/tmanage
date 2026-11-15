'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { getApprovalRecord } from '../../../lib/api/approval-records';
import {
  shortFingerprint,
  staffRecordHref,
  summarizeRecord,
} from '../../../lib/approval-record-presentation';
import { useApproverName } from '../../../lib/use-approver-name';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import '../../../styles/screens/approval-record.css';

export interface ApprovalRecordPanelProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  deliverableId: string;
  /** The approved approval's id, or null while no version is approved. */
  approvalId: string | null;
  /** "Ask for a new approval" on a changed record — the screen's own send dialog. */
  onSendForApproval?: () => void;
}

/** 52-19 (Figma 604:33899 aside, state cards 604:34167–34211): the internal approval record panel. */
export function ApprovalRecordPanel(props: ApprovalRecordPanelProps) {
  const t = useT();
  if (props.approvalId === null) {
    return (
      <section className="tm-card tm-prj-card tm-arec" aria-labelledby="tm-arec-title">
        <PanelHeader>
          <StateCapsule state="waiting">{t('ApprovalRecord.waiting')}</StateCapsule>
        </PanelHeader>
        {/* The design's "Send for approval" here is left to the version row, which already offers
            it whenever sending is possible — one button per action. */}
        <p className="tm-arec__text">{t('ApprovalRecord.waitingBody')}</p>
      </section>
    );
  }
  return <RecordBody {...props} approvalId={props.approvalId} />;
}

function PanelHeader({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <div className="tm-arec__head">
      <h2 id="tm-arec-title" className="tm-arec__title">
        {t('ApprovalRecord.title')}
      </h2>
      {children}
    </div>
  );
}

function RecordBody({
  api,
  organizationSlug,
  projectId,
  deliverableId,
  approvalId,
  onSendForApproval,
}: ApprovalRecordPanelProps & { approvalId: string }) {
  const t = useT();
  const fmt = useDisplayFormatters();
  const [copied, setCopied] = useState(false);
  const record = useQuery({
    queryKey: ['approval-record', organizationSlug, approvalId],
    queryFn: () => getApprovalRecord(api, organizationSlug, approvalId),
  });
  const summary = record.data ? summarizeRecord(record.data) : null;
  const evidence = summary?.decisive?.evidence ?? null;
  const approver = useApproverName(api, organizationSlug, evidence?.approver ?? null);

  if (record.isPending) {
    return (
      <section className="tm-card tm-prj-card tm-arec" aria-labelledby="tm-arec-title">
        <PanelHeader />
        <LoadingRegion label={t('ApprovalRecord.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </section>
    );
  }
  if (record.isError || !summary || !evidence || !record.data) {
    return (
      <section className="tm-card tm-prj-card tm-arec" aria-labelledby="tm-arec-title">
        <PanelHeader />
        <InlineAlert tone="warning" title={t('ApprovalRecord.checkFailedLabel')} live>
          {t('ApprovalRecord.checkFailedBody')}
        </InlineAlert>
        <div>
          <Button tone="outline" size="accessible" onClick={() => void record.refetch()}>
            {t('ApprovalRecord.tryAgain')}
          </Button>
        </div>
      </section>
    );
  }

  const fallbackName =
    evidence.approver.kind === 'client'
      ? t('ApprovalRecord.someoneClient')
      : t('ApprovalRecord.someoneTeam');
  const name = approver.name ?? fallbackName;

  if (summary.status === 'changed') {
    return (
      <section className="tm-card tm-prj-card tm-arec" aria-labelledby="tm-arec-title">
        <PanelHeader>
          <StateCapsule state="blocked">{t('ApprovalRecord.changed')}</StateCapsule>
        </PanelHeader>
        <InlineAlert tone="danger" title={t('ApprovalRecord.changedLabel')}>
          {t('ApprovalRecord.changedBody').replace('{name}', name)}
        </InlineAlert>
        <Fact label={t('ApprovalRecord.approvedFingerprint')} mono>
          {shortFingerprint(evidence.contentHash)}
        </Fact>
        {record.data.contentHash !== evidence.contentHash ? (
          <Fact label={t('ApprovalRecord.currentFingerprint')} mono danger>
            {shortFingerprint(record.data.contentHash)}
          </Fact>
        ) : null}
        {onSendForApproval ? (
          <div>
            <Button tone="ink" size="accessible" onClick={onSendForApproval}>
              {t('ApprovalRecord.askAgain')}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(evidence.contentHash);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="tm-card tm-prj-card tm-arec" aria-labelledby="tm-arec-title">
      <PanelHeader>
        <StateCapsule state="done">{t('ApprovalRecord.verified')}</StateCapsule>
      </PanelHeader>
      <div className="tm-arec__person">
        <Avatar
          name={name}
          audience={evidence.approver.kind === 'client' ? 'client' : 'internal'}
          decorative
        />
        <div>
          <p className="tm-arec__name" dir="auto">
            {name}
          </p>
          <p className="tm-arec__muted" dir="auto">
            {evidence.approver.kind === 'client'
              ? approver.company
                ? t('ApprovalRecord.roleClient').replace('{company}', approver.company)
                : t('ApprovalRecord.someoneClient')
              : t('ApprovalRecord.roleTeam')}
          </p>
        </div>
      </div>
      <Fact label={t('ApprovalRecord.version')}>v{evidence.versionNo ?? '–'}</Fact>
      <Fact label={t('ApprovalRecord.approvedOn')}>{fmt.dateTime(evidence.decidedAt)}</Fact>
      <Fact label={t('ApprovalRecord.approvedFrom')}>
        {evidence.approver.kind === 'client'
          ? t('ApprovalRecord.fromPortal')
          : t('ApprovalRecord.fromTeam')}
      </Fact>
      <Fact label={t('ApprovalRecord.fingerprint')} mono>
        {shortFingerprint(evidence.contentHash)}
      </Fact>
      <InlineAlert tone="success" title={t('ApprovalRecord.verified')}>
        {t('ApprovalRecord.verifiedBody')}
      </InlineAlert>
      <p className="tm-arec__muted">{t('ApprovalRecord.fingerprintHelp')}</p>
      <div className="tm-row tm-row--wrap">
        <Link
          className="tm-button tm-button--ink tm-button--accessible"
          href={staffRecordHref(organizationSlug, projectId, deliverableId, approvalId)}
        >
          {t('ApprovalRecord.viewCertificate')}
        </Link>
        <Button tone="outline" size="accessible" onClick={() => void copy()}>
          {copied ? t('ApprovalRecord.copied') : t('ApprovalRecord.copyFingerprint')}
        </Button>
      </div>
    </section>
  );
}

export function Fact({
  label,
  children,
  mono = false,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  danger?: boolean;
}) {
  const classes = ['tm-arec__value', mono ? 'tm-arec__value--mono' : '', danger ? 'is-danger' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="tm-arec__fact">
      <p className="tm-arec__muted">{label}</p>
      <p className={classes} dir={mono ? 'ltr' : 'auto'}>
        {children}
      </p>
    </div>
  );
}
