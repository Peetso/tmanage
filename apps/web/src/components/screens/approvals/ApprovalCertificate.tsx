'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { browserApiClient } from '../../../lib/api/browser-client';
import {
  approvalEvidenceZipPath,
  approvalRecordPdfPath,
  approvalRecordVerifyHref,
  getApprovalRecord,
  getPortalApprovalRecord,
  portalApprovalRecordPdfPath,
  type ApprovalCertificateView,
} from '../../../lib/api/approval-records';
import { getDeliverable } from '../../../lib/api/deliverables';
import { getProject } from '../../../lib/api/projects';
import { getClientApproval } from '../../../lib/api/approvals';
import { fetchMyProfile } from '../../../lib/api/member-profile';
import {
  groupedFingerprint,
  shortFingerprint,
  summarizeRecord,
} from '../../../lib/approval-record-presentation';
import { useApproverName } from '../../../lib/use-approver-name';
import { useOrganizationName, usePortalNames } from '../../../lib/use-organization-names';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useHydrated } from '../../../lib/use-hydrated';
import { PdfDownloadButton } from './PdfDownloadButton';
import '../../../styles/screens/approval-record.css';

interface SheetProps {
  view: ApprovalCertificateView;
  organizationName: string;
  deliverableTitle: string;
  projectName: string | null;
  approverName: string | null;
  approverCompany: string | null;
  backHref: string;
  /** 52-19: the sealed PDF of this record (API path). */
  pdfPath: string;
  /** 52-19: the evidence ZIP (API path); staff only, so the portal passes none. */
  evidencePath?: string;
}

/**
 * 52-19 (Figma 605:34269 / AR 605:34313): the printable approval record — an A4 sheet styled for
 * print, printed by the browser (`window.print`), plus the server's sealed PDF (52-19, "Download
 * PDF", offered only while the record verifies), and the public check: the decisive record's ID,
 * its fingerprint (the record hash) and the `/verify` link carrying both in its fragment.
 */
export function ApprovalRecordSheet({
  view,
  organizationName,
  deliverableTitle,
  projectName,
  approverName,
  approverCompany,
  backHref,
  pdfPath,
  evidencePath,
}: SheetProps) {
  const t = useT();
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const summary = summarizeRecord(view);
  const evidence = summary.decisive?.evidence ?? null;
  const verified = summary.status === 'verified';
  const today = fmt.day(new Date().toISOString());
  const locale = useActiveLocale();
  const hydrated = useHydrated();
  const decisive = summary.decisive;
  // 52-19: the public check's link; the ID and fingerprint ride in the fragment (never sent on).
  const verifyHref =
    decisive === null
      ? null
      : approvalRecordVerifyHref(decisive.recordId, decisive.recordHash, locale.startsWith('ar'));
  const verifyAddress = `${hydrated ? window.location.host : ''}${locale.startsWith('ar') ? '/ar' : ''}/verify`;

  const person =
    approverName ??
    (evidence?.approver.kind === 'client'
      ? t('ApprovalRecord.someoneClient')
      : t('ApprovalRecord.someoneTeam'));
  const who = approverCompany
    ? t('ApprovalRecord.ofCompany').replace('{name}', person).replace('{company}', approverCompany)
    : person;

  return (
    <div className="tm-acert">
      <div className="tm-acert__tools tm-row tm-row--wrap">
        <Link className="tm-button tm-button--outline tm-button--accessible" href={backHref}>
          {t('ApprovalRecord.back')}
        </Link>
        <Button tone="ink" size="accessible" onClick={() => window.print()}>
          {t('ApprovalRecord.print')}
        </Button>
        {verified ? (
          <PdfDownloadButton
            path={pdfPath}
            fileName={`approval-record-${view.approvalId}.pdf`}
            label={tOr('ApprovalRecord.downloadPdf', 'Download PDF')}
            busyLabel={tOr('ApprovalRecord.downloadingPdf', 'Preparing the PDF')}
            failedLabel={tOr(
              'ApprovalRecord.downloadPdfFailed',
              'The PDF could not be downloaded. Try again.',
            )}
          />
        ) : null}
        {verified && evidencePath !== undefined ? (
          <PdfDownloadButton
            path={evidencePath}
            fileName={`approval-evidence-${view.approvalId}.zip`}
            label={tOr('ApprovalRecord.downloadEvidence', 'Download evidence')}
            busyLabel={tOr('ApprovalRecord.downloadingEvidence', 'Preparing the evidence')}
            failedLabel={tOr(
              'ApprovalRecord.downloadEvidenceFailed',
              'The evidence could not be downloaded. Try again.',
            )}
            help={tOr(
              'ApprovalRecord.downloadEvidenceHelp',
              'One ZIP with this record, the approved file and the proof that nothing changed, so anyone can check it.',
            )}
          />
        ) : null}
      </div>
      <article className="tm-acert__sheet" aria-labelledby="tm-acert-title">
        <header className="tm-acert__top">
          <p className="tm-acert__org" dir="auto">
            {organizationName}
          </p>
        </header>
        <h1 id="tm-acert-title" className="tm-acert__title">
          {t('ApprovalRecord.title')}
        </h1>
        <p className="tm-acert__muted">{t('ApprovalRecord.docSubtitle')}</p>

        {evidence ? (
          <>
            <p className="tm-acert__lead" dir="auto">
              {(evidence.decision === 'approved'
                ? t('ApprovalRecord.sentence')
                : t('ApprovalRecord.sentenceChanges')
              )
                .replace('{name}', who)
                .replace('{version}', String(evidence.versionNo ?? '–'))
                .replace('{title}', deliverableTitle)
                .replace('{date}', fmt.dateTime(evidence.decidedAt))}
            </p>
            <hr className="tm-acert__rule" />
            <dl className="tm-acert__grid">
              {projectName ? (
                <div>
                  <dt>{t('ApprovalRecord.project')}</dt>
                  <dd dir="auto">{projectName}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t('ApprovalRecord.version')}</dt>
                <dd>v{evidence.versionNo ?? '–'}</dd>
              </div>
              <div>
                <dt>{t('ApprovalRecord.approvedFrom')}</dt>
                <dd>
                  {evidence.approver.kind === 'client'
                    ? t('ApprovalRecord.fromPortal')
                    : t('ApprovalRecord.fromTeam')}
                </dd>
              </div>
              <div>
                <dt>{t('ApprovalRecord.recordNumber')}</dt>
                <dd>{evidence.recordNo}</dd>
              </div>
              <div className="tm-acert__wide">
                <dt>{t('ApprovalRecord.fingerprint')}</dt>
                <dd className="tm-acert__mono" dir="ltr">
                  {groupedFingerprint(evidence.contentHash)}
                </dd>
              </div>
            </dl>
            {evidence.comment ? (
              <blockquote className="tm-acert__quote">
                <p dir="auto">“{evidence.comment}”</p>
                <footer className="tm-acert__muted" dir="auto">
                  {person}
                </footer>
              </blockquote>
            ) : null}
            <section className="tm-acert__check" aria-labelledby="tm-acert-check">
              <div className="tm-arec__head">
                <h2 id="tm-acert-check" className="tm-arec__title">
                  {t('ApprovalRecord.checkTitle')}
                </h2>
                <StateCapsule state={verified ? 'done' : 'blocked'}>
                  {verified
                    ? t('ApprovalRecord.verifiedOn').replace('{date}', today)
                    : t('ApprovalRecord.notVerified')}
                </StateCapsule>
              </div>
              <p className="tm-acert__body">
                {verified
                  ? t('ApprovalRecord.checkVerifiedBody')
                  : t('ApprovalRecord.checkChangedBody').replace('{org}', organizationName)}
              </p>
            </section>
            {verifyHref !== null && decisive !== null ? (
              <section className="tm-acert__check" aria-labelledby="tm-acert-verify">
                <h2 id="tm-acert-verify" className="tm-arec__title">
                  {tOr('ApprovalRecord.verifyTitle', 'Check this record')}
                </h2>
                <p className="tm-acert__body">
                  {tOr(
                    'ApprovalRecord.verifyBody',
                    'Anyone can check this record without an account at',
                  )}{' '}
                  <a href={verifyHref} dir="ltr">
                    {verifyAddress}
                  </a>
                </p>
                <dl className="tm-acert__grid">
                  <div className="tm-acert__wide">
                    <dt>{tOr('ApprovalRecord.recordId', 'Record ID')}</dt>
                    <dd className="tm-acert__mono" dir="ltr">
                      {decisive.recordId}
                    </dd>
                  </div>
                  <div className="tm-acert__wide">
                    <dt>{tOr('ApprovalRecord.recordFingerprint', 'Record fingerprint')}</dt>
                    <dd className="tm-acert__mono" dir="ltr">
                      {groupedFingerprint(decisive.recordHash)}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}
            {view.records.length > 1 ? (
              <section aria-labelledby="tm-acert-history">
                <h2 id="tm-acert-history" className="tm-arec__title">
                  {t('ApprovalRecord.history')}
                </h2>
                <ol className="tm-acert__history">
                  {[...view.records]
                    .sort((a, b) => a.recordNo - b.recordNo)
                    .map((record) => (
                      <li key={record.recordNo}>
                        <span>{fmt.dateTime(record.evidence.decidedAt)}</span>
                        <span>
                          {record.evidence.decision === 'approved'
                            ? t('Deliverables.approvalApproved')
                            : t('Deliverables.approvalChangesRequested')}
                        </span>
                        <span className="tm-acert__mono" dir="ltr">
                          {shortFingerprint(record.evidence.contentHash)}
                        </span>
                      </li>
                    ))}
                </ol>
              </section>
            ) : null}
          </>
        ) : (
          <p className="tm-acert__body">{t('ApprovalRecord.noRecord')}</p>
        )}
        <footer className="tm-acert__foot">
          <p dir="auto">{t('ApprovalRecord.issuedBy').replace('{org}', organizationName)}</p>
        </footer>
      </article>
    </div>
  );
}

function SheetState({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="tm-acert">
      {failed ? (
        <InlineAlert tone="danger" title={t('ApprovalRecord.loadFailed')} live>
          <Button tone="outline" size="compact" onClick={onRetry}>
            {t('ApprovalRecord.tryAgain')}
          </Button>
        </InlineAlert>
      ) : (
        <LoadingRegion label={t('ApprovalRecord.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      )}
    </div>
  );
}

export function StaffApprovalCertificate({
  organizationSlug,
  projectId,
  deliverableId,
  approvalId,
  client,
}: {
  organizationSlug: string;
  projectId: string;
  deliverableId: string;
  approvalId: string;
  client?: ApiClient;
}) {
  const api = client ?? browserApiClient();
  const organizationName = useOrganizationName(organizationSlug, FIXTURE_ORGANIZATION_NAME);
  const record = useQuery({
    queryKey: ['approval-record', organizationSlug, approvalId],
    queryFn: () => getApprovalRecord(api, organizationSlug, approvalId),
  });
  const deliverable = useQuery({
    queryKey: ['deliverable', organizationSlug, deliverableId],
    queryFn: () => getDeliverable(api, organizationSlug, deliverableId),
  });
  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });
  const evidence = record.data ? summarizeRecord(record.data).decisive?.evidence : undefined;
  const approver = useApproverName(api, organizationSlug, evidence?.approver ?? null);

  if (!record.data || !deliverable.data) {
    return (
      <SheetState
        failed={record.isError || deliverable.isError}
        onRetry={() => {
          void record.refetch();
          void deliverable.refetch();
        }}
      />
    );
  }
  return (
    <ApprovalRecordSheet
      view={record.data}
      organizationName={organizationName}
      deliverableTitle={deliverable.data.title}
      projectName={project.data?.name ?? null}
      approverName={approver.name}
      approverCompany={approver.company}
      backHref={`/${organizationSlug}/projects/${encodeURIComponent(projectId)}/deliverables/${encodeURIComponent(deliverableId)}`}
      pdfPath={approvalRecordPdfPath(organizationSlug, approvalId)}
      evidencePath={approvalEvidenceZipPath(organizationSlug, approvalId)}
    />
  );
}

export function PortalApprovalCertificate({
  organizationSlug,
  deliverableVersionId,
  client,
}: {
  organizationSlug: string;
  deliverableVersionId: string;
  client?: ApiClient;
}) {
  const api = client ?? browserApiClient();
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    FIXTURE_CLIENT_NAME,
    FIXTURE_ORGANIZATION_NAME,
  );
  const record = useQuery({
    queryKey: ['portal-approval-record', organizationSlug, deliverableVersionId],
    queryFn: () => getPortalApprovalRecord(api, organizationSlug, deliverableVersionId),
  });
  const projection = useQuery({
    queryKey: ['client-approval', organizationSlug, deliverableVersionId],
    queryFn: () => getClientApproval(api, organizationSlug, deliverableVersionId),
  });
  const me = useQuery({
    queryKey: ['my-profile', organizationSlug],
    queryFn: () => fetchMyProfile(api, organizationSlug),
    retry: false,
  });

  if (!record.data || !projection.data) {
    return (
      <SheetState
        failed={record.isError || projection.isError}
        onRetry={() => {
          void record.refetch();
          void projection.refetch();
        }}
      />
    );
  }
  return (
    <ApprovalRecordSheet
      view={record.data}
      organizationName={providerName}
      deliverableTitle={projection.data.projection.title}
      projectName={null}
      approverName={me.data?.displayName ?? null}
      approverCompany={clientName}
      backHref={`/${organizationSlug}/portal/deliverables/${encodeURIComponent(deliverableVersionId)}`}
      pdfPath={portalApprovalRecordPdfPath(organizationSlug, deliverableVersionId)}
    />
  );
}
