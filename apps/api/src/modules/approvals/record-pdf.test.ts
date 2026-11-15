import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderRecordPdf, setLine, visualRuns } from './record-pdf.js';
import { signedPdfDocument } from './record-pdf-documents.js';
import type { SignedDocumentFacts } from './record-pdf-documents.js';

const RECORD_HASH = 'ab'.repeat(32);
const RECORD_JSON = '{"decision":"signed","esign":{"signerName":"Layla ليلى"}}';

const facts: SignedDocumentFacts = {
  requestId: '0190a000-0000-7000-8000-000000000009',
  projectId: '0190a000-0000-7000-8000-000000000002',
  deliverableVersionId: '0190a000-0000-7000-8000-000000000003',
  title: 'Brand guide (final)',
  organizationName: 'North Studio',
  versionNo: 3,
  contentHash: 'cd'.repeat(32),
  documentUnchanged: true,
  original: null,
  signers: [
    {
      displayName: 'Layla ليلى',
      email: 'layla@client.example',
      clientOrganizationName: 'Client Co',
      method: 'typed',
      typedName: 'ليلى حسن',
      markObjectKey: null,
      markSha256: null,
      signedAt: '2026-11-15T10:00:00.000Z',
      codeVerifiedAt: '2026-11-15T10:00:00.000Z',
      consentTextVersion: 'esign-consent-v1',
      consentText: 'I agree to sign this document electronically.',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      recordNo: 7,
      recordHash: RECORD_HASH,
      previousRecordHash: '01'.repeat(32),
      recordJson: RECORD_JSON,
      signed: true,
    },
  ],
};

describe('52-19 / 52-26 record PDF', () => {
  it('sets an Arabic name in the Arabic face, in visual order, with no "?"', async () => {
    const line = setLine('Layla ليلى 12', () => true);
    expect(line.font).toBe('arabic');
    expect(line.lossy).toBe(false);
    expect(line.runs.map((r) => r.text).join('')).not.toContain('?');
    // An Arabic paragraph reads right to left: the digits run sits left of the name.
    const rtl = visualRuns('ليلى 12');
    expect(rtl.rtl).toBe(true);
    expect(rtl.runs.map((r) => r.text)).toEqual(['12', 'ليلى ']);

    const { bytes } = await renderRecordPdf(signedPdfDocument(facts, new Map()));
    const text = bytes.toString('latin1');
    expect(text).toContain('/FontFile2');
    expect(text).toContain('TManageAlexandria');
    expect(text).not.toContain('Some characters cannot be shown');
    // Deterministic: the same sealed records give the same bytes.
    expect((await renderRecordPdf(signedPdfDocument(facts, new Map()))).bytes.equals(bytes)).toBe(
      true,
    );
    const attachments = (await PDFDocument.load(bytes)).catalog.toString();
    expect(attachments).toContain('EmbeddedFiles');
  });

  it('puts the signed PDF first: original page count + 1 record page', async () => {
    const original = await PDFDocument.create();
    original.addPage();
    original.addPage();
    const rendered = await renderRecordPdf(signedPdfDocument(facts, new Map()), {
      original: await original.save(),
    });
    expect(rendered.originalPages).toBe(2);
    expect((await PDFDocument.load(rendered.bytes)).getPageCount()).toBe(3);

    const broken = await renderRecordPdf(signedPdfDocument(facts, new Map()), {
      original: Buffer.from('%PDF-1.7 not really'),
    });
    expect(broken.originalPages).toBeNull();
    expect((await PDFDocument.load(broken.bytes)).getPageCount()).toBe(1);
  });
});
