import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, utf8 } from './bytes.js';
import {
  SigningMaterialError,
  certificateSignatureDer,
  checkSigningMaterial,
  parseCertificate,
  phase2Qr,
  publicKeyDer,
  selfSignedCertificate,
  signXml,
  verifyXmlSignature,
} from './sign.js';
import { decodeTlv } from './tlv.js';

function keyPem(curve: string): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const NOW = new Date('2026-11-02T10:00:00Z');
const key = keyPem('secp256k1');
const cert = (privateKeyPem: string, issuerCn = 'TManage Test CA'): string =>
  selfSignedCertificate({
    privateKeyPem,
    issuerCn,
    subjectCn: 'Acme Studio',
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
  });

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SigningMaterialError) return error.reason;
    throw error;
  }
  return 'none';
}

describe('ZATCA Phase-2 signing (52-12 R22-a)', () => {
  it('signs an XML with a secp256k1 certificate and verifies it; a changed byte fails', () => {
    const facts = checkSigningMaterial(cert(key), key, NOW);
    expect(facts.fingerprint256).toMatch(/^[0-9a-f]{64}$/u);
    expect(facts.sandbox).toBe(false);
    const xml = '<Invoice>1</Invoice>';
    const signature = signXml(xml, key);
    expect(verifyXmlSignature(xml, signature, facts.publicKeyPem)).toBe(true);
    expect(verifyXmlSignature('<Invoice>2</Invoice>', signature, facts.publicKeyPem)).toBe(false);
  });

  it('refuses a P-256 key, a key of another certificate, and an expired certificate', () => {
    const p256 = keyPem('prime256v1');
    expect(rejection(() => checkSigningMaterial(cert(p256), p256, NOW))).toBe('unsupported_curve');
    expect(rejection(() => checkSigningMaterial(cert(key), keyPem('secp256k1'), NOW))).toBe(
      'certificate_key_mismatch',
    );
    expect(rejection(() => checkSigningMaterial(cert(key), key, new Date('2028-01-01')))).toBe(
      'certificate_expired',
    );
    expect(rejection(() => checkSigningMaterial('not a cert', key, NOW))).toBe(
      'invalid_certificate',
    );
  });

  it('marks a PREZATCA issuer as sandbox; no message carries key text', () => {
    expect(parseCertificate(cert(key, 'PRZEINVOICESCA4-PREZATCA-CA')).sandbox).toBe(true);
    const error = new SigningMaterialError('invalid_key');
    expect(error.message).not.toContain('PRIVATE KEY');
  });

  it('builds the Phase-2 QR: nine tags, tag 6 = the stored hash, tag 7 = the signature', () => {
    const pem = cert(key);
    const facts = parseCertificate(pem);
    const xml = '<Invoice>1</Invoice>';
    const hash = sha256Hex(utf8(xml));
    const signature = signXml(xml, key);
    const qr = phase2Qr(
      {
        sellerName: 'Acme',
        vatNumber: '300000000000003',
        timestamp: NOW,
        totalWithVat: '115.00',
        vatAmount: '15.00',
      },
      {
        xmlHashHex: hash,
        signatureB64: signature,
        publicKeyDer: publicKeyDer(facts.publicKeyPem),
        certSignatureDer: certificateSignatureDer(pem),
      },
    );
    const tags = decodeTlv(qr);
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tags[5]?.value).toBe(hash);
    expect(tags[6]?.value).toBe(signature);
    expect(tags[7]?.length).toBe(publicKeyDer(facts.publicKeyPem).length);
  });
});
