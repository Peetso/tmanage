import type { ZipEntry } from '../finance/zip-store.js';
import { canonicalJson } from '../audit/audit-chain.js';
import { recordGenesisHash } from './approval-records.js';
import type { ApprovalCertificateView } from './approvals.service.js';
import type { EvidenceChainCheck } from './approval-records-evidence.repository.js';
import type { RecordAudience } from './record-pdf.service.js';

/**
 * 52-19 — the evidence bundle of one approval, as pure functions: what goes into the ZIP and in
 * which words. No I/O; the service reads, authorizes and checks, then hands the facts here.
 *
 * The bundle holds the sealed record PDF, the approved file exactly as stored (only when its bytes
 * still hash to the stored SHA-256), `chain-proof.json` (every record's canonical JSON, its hash,
 * the previous link, the check done at download time and the newest nightly chain walk) and a
 * README in English and Arabic on how anyone can re-check the hashes without TManage.
 */

export const EVIDENCE_SCHEMA = 'tmanage.approval.evidence.v1';

/** The approved file is included up to this size; a larger one is named by its hash only. */
export const MAX_EVIDENCE_FILE_BYTES = 25 * 1024 * 1024;

/** Why the approved file is (or is not) inside the bundle. */
export type EvidenceFileOutcome =
  'included' | 'too_large' | 'not_cleared' | 'unavailable' | 'does_not_match';

export interface EvidenceFileFacts {
  readonly fileVersionId: string;
  readonly name: string;
  readonly versionNo: number;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly outcome: EvidenceFileOutcome;
  /** Present only when `outcome` is `included`. */
  readonly bytes: Buffer | null;
}

export interface EvidenceInput {
  readonly view: ApprovalCertificateView;
  readonly audience: RecordAudience;
  readonly recordPdf: Buffer;
  readonly chainCheck: EvidenceChainCheck | null;
  readonly file: EvidenceFileFacts | null;
  readonly createdAt: Date;
}

const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}]/gu;
const NAME_MAX = 120;

/** A stored file name as one ZIP entry: no folders, no control characters, no leading dots. */
export function evidenceFileName(name: string, versionNo: number): string {
  const cleaned = name
    .normalize('NFC')
    .replace(UNSAFE_NAME, '-')
    .replace(/^[.\s-]+/u, '')
    .trim()
    .slice(0, NAME_MAX);
  return `approved-file/v${versionNo}-${cleaned.length > 0 ? cleaned : 'file'}`;
}

export function evidenceZipName(approvalId: string): string {
  return `approval-evidence-${approvalId}.zip`;
}

function nightlyCheck(check: EvidenceChainCheck | null, audience: RecordAudience): unknown {
  if (check === null) return null;
  const verdict = { checkedAt: check.checkedAt.toISOString(), status: check.status };
  // The record count and the break position describe the whole workspace: staff only.
  if (audience === 'portal') return verdict;
  return {
    ...verdict,
    records: check.records,
    breakRecordNo: check.breakRecordNo,
    breakReason: check.breakReason,
  };
}

function fileProof(file: EvidenceFileFacts | null): unknown {
  if (file === null) return null;
  return {
    fileVersionId: file.fileVersionId,
    versionNo: file.versionNo,
    name: file.name,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    included: file.outcome === 'included',
    outcome: file.outcome,
    path: file.outcome === 'included' ? evidenceFileName(file.name, file.versionNo) : null,
  };
}

/** `chain-proof.json`: what was checked, with everything needed to check it again. */
export function chainProof(input: EvidenceInput): string {
  const { view } = input;
  const proof = {
    schema: EVIDENCE_SCHEMA,
    createdAt: input.createdAt.toISOString(),
    approval: {
      approvalId: view.approvalId,
      deliverableVersionId: view.deliverableVersionId,
      contentHash: view.contentHash,
      state: view.state,
      decidedAt: view.decidedAt,
    },
    checkedAtDownload: { intact: view.intact },
    genesis: {
      rule: 'sha256("tmanage.approval.record.genesis:" + organizationId)',
      organizationId: view.organizationId,
      hash: recordGenesisHash(view.organizationId),
    },
    records: view.records.map((record) => ({
      recordNo: record.recordNo,
      recordHash: record.recordHash,
      previousRecordHash: record.previousRecordHash,
      signed: record.signed,
      verification: record.verification,
      recordJson: canonicalJson(record.evidence),
    })),
    nightlyCheck: nightlyCheck(input.chainCheck, input.audience),
    file: fileProof(input.file),
  };
  return `${JSON.stringify(proof, null, 2)}\n`;
}

const README_EN = [
  'TManage approval evidence',
  '=========================',
  '',
  'This folder proves who approved which file, and when.',
  '',
  'What is inside',
  '- approval-record.pdf: the sealed approval record, as printed by TManage.',
  '- approved-file/: the exact file that was approved (when it was small enough to include).',
  '- chain-proof.json: the record data, its fingerprints (SHA-256 hashes) and the checks.',
  '',
  'How to check it yourself',
  '1. The file: compute the SHA-256 of the file in approved-file/ (for example',
  '   "sha256sum <file>" or "certutil -hashfile <file> SHA256"). It must equal file.sha256',
  '   in chain-proof.json.',
  '2. Each record: compute the SHA-256 of the record\'s "recordJson" text, exactly as written',
  '   (UTF-8, no extra spaces). It must equal its "recordHash".',
  '3. The chain: each record\'s "previousRecordHash" is the hash of the record before it in this',
  '   workspace. Record 1 points at the "genesis" hash, which anyone can recompute with the rule',
  '   shown. Changing any earlier record would break this link.',
  '4. "checkedAtDownload" is TManage\'s own check when this folder was made, and "nightlyCheck"',
  '   is the newest result of the nightly walk over the whole chain.',
  '',
  'The "signed" mark is a seal made with a key held by TManage; only TManage can confirm it.',
  'The hashes above can be checked by anyone, without TManage.',
];

const README_AR = [
  'أدلة الاعتماد من TManage',
  '========================',
  '',
  'يثبت هذا المجلد من اعتمد أي ملف ومتى.',
  '',
  'المحتويات',
  '- approval-record.pdf: سجل الاعتماد المختوم كما أصدرته TManage.',
  '- approved-file/: الملف المعتمد نفسه (إذا كان حجمه يسمح بإرفاقه).',
  '- chain-proof.json: بيانات السجل وبصماته (تجزئة SHA-256) ونتائج الفحص.',
  '',
  'كيف تتحقق بنفسك',
  '1. الملف: احسب تجزئة SHA-256 للملف الموجود في approved-file/، ويجب أن تطابق file.sha256.',
  '2. كل سجل: احسب تجزئة SHA-256 لنص "recordJson" كما هو تمامًا، ويجب أن تطابق "recordHash".',
  '3. السلسلة: يحمل كل سجل في "previousRecordHash" بصمة السجل الذي قبله في مساحة العمل، ويشير',
  '   السجل الأول إلى بصمة "genesis" التي يمكن لأي أحد إعادة حسابها. أي تعديل على سجل سابق يكسر هذه السلسلة.',
  '4. "checkedAtDownload" هو فحص TManage عند تجهيز المجلد، و"nightlyCheck" آخر فحص ليلي للسلسلة كلها.',
  '',
  'علامة "signed" ختم بمفتاح تحتفظ به TManage، ولا يؤكده غيرها. أما البصمات فيمكن لأي أحد التحقق منها.',
];

export function evidenceReadme(): string {
  return `${[...README_EN, '', '', ...README_AR].join('\n')}\n`;
}

/** The ZIP entries, in the order a reader meets them. */
export function evidenceEntries(input: EvidenceInput): readonly ZipEntry[] {
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: Buffer.from(evidenceReadme(), 'utf8') },
    { name: 'approval-record.pdf', data: input.recordPdf },
    { name: 'chain-proof.json', data: Buffer.from(chainProof(input), 'utf8') },
  ];
  const file = input.file;
  if (file !== null && file.outcome === 'included' && file.bytes !== null) {
    entries.push({ name: evidenceFileName(file.name, file.versionNo), data: file.bytes });
  }
  return entries;
}
