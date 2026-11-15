import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderRecordPdf } from './record-pdf.js';
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
  signers: [
    {
      displayName: 'Layla ليلى',
      email: 'layla@client.example',
      clientOrganizationName: 'Client Co',
      method: 'drawn',
      typedName: null,
      markObjectKey: 'tenant/x/mark',
      markSha256: 'ef'.repeat(32),
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

describe('52-26 signed PDF', () => {
  it('prints the record hash and carries the exact sealed record as an attachment', () => {
    const mark = { width: 2, height: 1, rgb: Buffer.alloc(6), alpha: Buffer.from([255, 0]) };
    const marks = new Map([['ef'.repeat(32), mark]]);
    const pdf = renderRecordPdf(signedPdfDocument(facts, marks));
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain(`(${RECORD_HASH}) Tj`);
    expect(text).toContain('/Im1 Do');
    // A name outside WinAnsi prints as "?" and the page says the attachment holds the exact text.
    expect(text).toContain('(Signature 1: Layla ????) Tj');
    expect(text).toContain('attached record files hold the exact text');
    // Deterministic: the same sealed records give the same bytes.
    expect(renderRecordPdf(signedPdfDocument(facts, marks)).equals(pdf)).toBe(true);

    const embedded = /\/Type \/EmbeddedFile[^\n]*?\/Length (\d+) >>\nstream\n/.exec(text);
    expect(embedded).not.toBeNull();
    const start = (embedded?.index ?? 0) + (embedded?.[0].length ?? 0);
    const bytes = pdf.subarray(start, start + Number(embedded?.[1]));
    expect(inflateSync(bytes).toString('utf8')).toBe(RECORD_JSON);
  });
});
