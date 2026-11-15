import { canonicalJson } from '../audit/audit-chain.js';
import type { ApprovalCertificateView } from './approvals.service.js';
import type { PdfDocument, PdfImage, PdfRow, PdfSection } from './record-pdf.js';

/**
 * 52-19 / 52-26 — what the two sealed record PDFs say, as pure functions of data the services
 * already authorized and verified. English only: the server has no locale catalog, and the
 * attached record files carry the exact sealed text in every language.
 */

/** Display names the certificate cannot read from the sealed JSON (it holds ids only). */
export interface CertificateNames {
  readonly organizationName: string;
  readonly projectName: string;
  readonly deliverableTitle: string;
  /** Keyed by membership id. */
  readonly approvers: ReadonlyMap<string, string>;
}

/** 52-26 — one signer's sealed signature, as the e-sign service assembled and checked it. */
export interface SignedSignerFacts {
  readonly displayName: string;
  readonly email: string;
  readonly clientOrganizationName: string;
  readonly method: 'typed' | 'drawn';
  readonly typedName: string | null;
  readonly markObjectKey: string | null;
  readonly markSha256: string | null;
  readonly signedAt: string;
  readonly codeVerifiedAt: string;
  readonly consentTextVersion: string;
  readonly consentText: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly recordNo: number;
  readonly recordHash: string;
  readonly previousRecordHash: string;
  readonly recordJson: string;
  readonly signed: boolean;
}

/** 52-26 — a signature request and the signatures the reader may see. */
export interface SignedDocumentFacts {
  readonly requestId: string;
  readonly projectId: string;
  readonly deliverableVersionId: string;
  readonly title: string;
  readonly organizationName: string;
  readonly versionNo: number | null;
  readonly contentHash: string;
  readonly documentUnchanged: boolean;
  readonly signers: readonly SignedSignerFacts[];
}

const CHAIN_NOTE =
  'Each record carries the hash of the record before it in this workspace, so changing any ' +
  'earlier record breaks the chain. The seal is an HMAC under the workspace key held by TManage.';

export function utc(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function seal(signed: boolean): string {
  return signed ? 'Sealed with the workspace key (HMAC-SHA-256)' : 'Not sealed (no key configured)';
}

function recordRows(record: {
  readonly recordNo: number;
  readonly recordHash: string;
  readonly previousRecordHash: string;
  readonly signed: boolean;
}): PdfRow[] {
  return [
    { label: 'Record number', value: String(record.recordNo) },
    { label: 'Record hash (SHA-256)', value: record.recordHash, mono: true },
    { label: 'Previous record hash', value: record.previousRecordHash, mono: true },
    { label: 'Seal', value: seal(record.signed) },
  ];
}

function recordFile(recordNo: number, json: string, hash: string) {
  return {
    name: `record-${recordNo}.json`,
    mimeType: 'application/json',
    description: `Sealed record ${recordNo}; SHA-256 ${hash}`,
    bytes: Buffer.from(json, 'utf8'),
  };
}

/** 52-19 — the approval certificate: the version decided on and every sealed decision record. */
export function certificatePdfDocument(
  view: ApprovalCertificateView,
  names: CertificateNames,
): PdfDocument {
  const decided = view.records.map((record): PdfSection => {
    const e = record.evidence;
    const decision = e.decision === 'approved' ? 'Approved' : 'Changes requested';
    return {
      heading: `Decision ${record.recordNo}: ${decision}`,
      rows: [
        { label: 'Decided by', value: names.approvers.get(e.approver.membershipId) ?? '' },
        { label: 'Approver', value: e.approver.kind === 'client' ? 'Client' : 'Team member' },
        { label: 'Role', value: e.approver.role },
        { label: 'Decision', value: decision },
        { label: 'Comment', value: e.comment ?? '' },
        { label: 'Decided at', value: utc(e.decidedAt) },
        { label: 'IP address', value: e.ip ?? '' },
        { label: 'Device', value: e.userAgent ?? '' },
        ...recordRows(record),
      ],
    };
  });
  return {
    title: 'Approval record',
    subtitle: [names.organizationName, names.projectName, names.deliverableTitle]
      .filter((part) => part !== '')
      .join('  /  '),
    subject: `Approval record ${view.records.map((r) => r.recordHash).join(' ')}`,
    sections: [
      {
        heading: 'Document',
        rows: [
          { label: 'Deliverable', value: names.deliverableTitle },
          { label: 'Version', value: String(view.records[0]?.evidence.versionNo ?? '') },
          { label: 'Document SHA-256', value: view.contentHash, mono: true },
          { label: 'Approval state', value: view.state.replace(/_/g, ' ') },
          { label: 'Decided at', value: utc(view.decidedAt) },
        ],
      },
      ...decided,
    ],
    notes: [
      'This PDF shows sealed approval records. Each record is attached to this file as ' +
        'record-<number>.json; the SHA-256 of that file is the record hash printed above.',
      CHAIN_NOTE,
    ],
    footer: `TManage approval record  /  approval ${view.approvalId}`,
    // A verified record's JSON is canonical, so re-serialising the evidence gives the sealed bytes.
    attachments: view.records.map((r) =>
      recordFile(r.recordNo, canonicalJson(r.evidence), r.recordHash),
    ),
  };
}

/** 52-26 — the signature page(s) of a signed document. `marks` are keyed by mark SHA-256. */
export function signedPdfDocument(
  facts: SignedDocumentFacts,
  marks: ReadonlyMap<string, PdfImage>,
): PdfDocument {
  const signatures = facts.signers.map((signer, index): PdfSection => {
    const image = signer.markSha256 === null ? undefined : marks.get(signer.markSha256);
    return {
      heading: `Signature ${index + 1}: ${signer.displayName}`,
      rows: [
        { label: 'Signer', value: signer.displayName },
        { label: 'E-mail', value: signer.email },
        { label: 'Client', value: signer.clientOrganizationName },
        {
          label: 'Signed with',
          value: signer.method === 'typed' ? 'Typed name' : 'Drawn signature',
        },
        ...(signer.typedName === null ? [] : [{ label: 'Typed name', value: signer.typedName }]),
        ...(signer.markSha256 === null
          ? []
          : [{ label: 'Drawn mark SHA-256', value: signer.markSha256, mono: true }]),
        { label: 'Signed at', value: utc(signer.signedAt) },
        {
          label: 'E-mail check',
          value: `One-time code sent to ${signer.email}, verified ${utc(signer.codeVerifiedAt)}`,
        },
        { label: 'Consent', value: `${signer.consentText} (${signer.consentTextVersion})` },
        { label: 'IP address', value: signer.ip ?? '' },
        { label: 'Device', value: signer.userAgent ?? '' },
        ...recordRows(signer),
      ],
      ...(image === undefined ? {} : { image }),
    };
  });
  return {
    title: 'Signed document',
    subtitle: [facts.organizationName, facts.title].filter((part) => part !== '').join('  /  '),
    subject: `Signed document ${facts.signers.map((s) => s.recordHash).join(' ')}`,
    sections: [
      {
        heading: 'Document',
        rows: [
          { label: 'Document', value: facts.title },
          { label: 'Version', value: facts.versionNo === null ? '' : String(facts.versionNo) },
          { label: 'Document SHA-256', value: facts.contentHash, mono: true },
          {
            label: 'Unchanged since signing',
            value: facts.documentUnchanged ? 'Yes' : 'No: the document changed later',
          },
        ],
      },
      ...signatures,
    ],
    notes: [
      'The signed document is the file whose SHA-256 is printed above; any copy with the same ' +
        'hash is that exact document. Each signature record is attached to this file as ' +
        'record-<number>.json; the SHA-256 of that file is the record hash printed above.',
      CHAIN_NOTE,
    ],
    footer: `TManage signed document  /  request ${facts.requestId}`,
    attachments: facts.signers.map((s) => recordFile(s.recordNo, s.recordJson, s.recordHash)),
  };
}
