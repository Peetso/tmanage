import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { toBase64, utf8 } from './bytes.js';
import { phase1Qr, tlvField } from './tlv.js';
import type { Phase1QrInput } from './tlv.js';

/**
 * 52-12 (R22-a) — ZATCA Phase-2 signing: certificate facts, key checks, ECDSA secp256k1 over the
 * XML, verification and the Phase-2 QR (TLV tags 1–9).
 *
 * ## Why this module is NOT exported from the package index
 *
 * It imports `node:crypto` (like `security/field-cipher.ts`); the index is bundled into the
 * browser. The API imports it through the subpath `@tmanage/domain/zatca-sign`.
 *
 * ## What is signed
 *
 * The UBL XML is a deterministic hand-built string (`ubl.ts`): the same stored row always yields
 * the same bytes. The signature therefore covers those bytes exactly (ECDSA-SHA256 over UTF-8)
 * instead of an XML C14N pass — stated deviation; the ZATCA SDK validator and proper C14N are a
 * later pass, like reporting and clearance.
 *
 * ## Errors
 *
 * {@link SigningMaterialError} carries a fixed reason and a fixed message. Nothing here ever puts
 * certificate or key text into a message, so a caller may log or return the reason as is.
 */

export type SigningMaterialRejection =
  | 'invalid_certificate'
  | 'invalid_key'
  | 'unsupported_curve'
  | 'certificate_key_mismatch'
  | 'certificate_expired';

const MESSAGES: Readonly<Record<SigningMaterialRejection, string>> = {
  invalid_certificate: 'The certificate is not a valid PEM X.509 certificate.',
  invalid_key: 'The private key is not a valid PEM private key.',
  unsupported_curve: 'The key must be an ECDSA secp256k1 key.',
  certificate_key_mismatch: 'The private key does not belong to the certificate.',
  certificate_expired: 'The certificate is expired or not yet valid.',
};

export class SigningMaterialError extends Error {
  constructor(public readonly reason: SigningMaterialRejection) {
    super(MESSAGES[reason]);
    this.name = 'SigningMaterialError';
  }
}

/** The public facts of a certificate — safe to store in `org_secrets.meta_json` and to return. */
export interface CertificateFacts {
  readonly issuer: string;
  readonly subject: string;
  readonly serial: string;
  /** ISO 8601. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** SHA-256 of the DER certificate, lowercase hex (64 chars). */
  readonly fingerprint256: string;
  readonly publicKeyPem: string;
  /** The issuer CN names the ZATCA sandbox CA (`PREZATCA` / `TSTZATCA`). */
  readonly sandbox: boolean;
}

const CURVE = 'secp256k1';
const SANDBOX_ISSUER = /PREZATCA|TSTZATCA/iu;

function issuerCn(issuer: string): string {
  const cn = issuer
    .split(/\r?\n|,\s*/u)
    .find((part) => part.trim().toUpperCase().startsWith('CN='));
  return cn === undefined ? issuer : cn.trim().slice(3);
}

function certificateOf(pem: string): X509Certificate {
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new SigningMaterialError('invalid_certificate');
  }
  try {
    return new X509Certificate(pem);
  } catch {
    throw new SigningMaterialError('invalid_certificate');
  }
}

export function parseCertificate(pem: string): CertificateFacts {
  const cert = certificateOf(pem);
  const publicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    issuer: cert.issuer,
    subject: cert.subject,
    serial: cert.serialNumber.toLowerCase(),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: new Date(cert.validTo).toISOString(),
    fingerprint256: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    publicKeyPem,
    sandbox: SANDBOX_ISSUER.test(issuerCn(cert.issuer)),
  };
}

function curveOf(key: KeyObject): string | undefined {
  return key.asymmetricKeyType === 'ec' ? key.asymmetricKeyDetails?.namedCurve : undefined;
}

/**
 * Checks a private key against a certificate: secp256k1 only, and its public half must be the
 * certificate's. Throws {@link SigningMaterialError}; returns nothing (the PEM stays the caller's).
 */
export function parseSigningKey(privateKeyPem: string, certificate: CertificateFacts): void {
  let key: KeyObject;
  try {
    if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY-----')) {
      throw new Error('not pem');
    }
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new SigningMaterialError('invalid_key');
  }
  if (curveOf(key) !== CURVE) throw new SigningMaterialError('unsupported_curve');
  const certKey = createPublicKey(certificate.publicKeyPem);
  if (curveOf(certKey) !== CURVE) throw new SigningMaterialError('unsupported_curve');
  const mine = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const theirs = certKey.export({ type: 'spki', format: 'der' });
  if (!mine.equals(theirs)) throw new SigningMaterialError('certificate_key_mismatch');
}

/** Every check a stored certificate must pass: parse, curve, key match, validity at `now`. */
export function checkSigningMaterial(
  certificatePem: string,
  privateKeyPem: string,
  now: Date,
): CertificateFacts {
  const facts = parseCertificate(certificatePem);
  parseSigningKey(privateKeyPem, facts);
  const at = now.getTime();
  if (at < Date.parse(facts.notBefore) || at > Date.parse(facts.notAfter)) {
    throw new SigningMaterialError('certificate_expired');
  }
  return facts;
}

/** ECDSA-SHA256 over the UTF-8 XML, base64 DER (`SEQUENCE { r, s }`). */
export function signXml(xml: string, privateKeyPem: string): string {
  const signature = nodeSign('sha256', Buffer.from(xml, 'utf8'), createPrivateKey(privateKeyPem));
  return signature.toString('base64');
}

/** True when `signatureB64` is a valid signature of the XML under the public key. */
export function verifyXmlSignature(
  xml: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    return nodeVerify(
      'sha256',
      Buffer.from(xml, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/** The SubjectPublicKeyInfo DER of a public key (QR tag 8). */
export function publicKeyDer(publicKeyPem: string): Uint8Array {
  return Uint8Array.from(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }));
}

// ── minimal DER ──────────────────────────────────────────────────────────────

function readLength(bytes: Uint8Array, at: number): { length: number; next: number } {
  const first = bytes[at] ?? 0;
  if (first < 0x80) return { length: first, next: at + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new SigningMaterialError('invalid_certificate');
  let length = 0;
  for (let i = 1; i <= count; i += 1) length = length * 256 + (bytes[at + i] ?? 0);
  return { length, next: at + 1 + count };
}

/** One element at `at`: its tag, where its content starts, and where the element ends. */
function element(bytes: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const { length, next } = readLength(bytes, at + 1);
  const end = next + length;
  if (end > bytes.length) throw new SigningMaterialError('invalid_certificate');
  return { tag: bytes[at] ?? 0, start: next, end };
}

/** The certificate's own signature (`signatureValue` BIT STRING, unused-bits byte dropped): tag 9. */
export function certificateSignatureDer(certificatePem: string): Uint8Array {
  const der = Uint8Array.from(certificateOf(certificatePem).raw);
  const outer = element(der, 0);
  const tbs = element(der, outer.start);
  const algorithm = element(der, tbs.end);
  const value = element(der, algorithm.end);
  if (outer.tag !== 0x30 || value.tag !== 0x03)
    throw new SigningMaterialError('invalid_certificate');
  return der.slice(value.start + 1, value.end);
}

export interface Phase2Parts {
  /** SHA-256 hex of the XML, as stored in `zatca_xml_hash` (tag 6). */
  readonly xmlHashHex: string;
  /** Base64 DER ECDSA signature, as stored in `zatca_signature` (tag 7). */
  readonly signatureB64: string;
  /** SubjectPublicKeyInfo DER (tag 8). */
  readonly publicKeyDer: Uint8Array;
  /** The certificate's signature by its CA, DER (tag 9). */
  readonly certSignatureDer: Uint8Array;
}

/** The Phase-2 QR: tags 1–5 as Phase 1, then hash, signature, public key, certificate signature. */
export function phase2Qr(phase1: Phase1QrInput, parts: Phase2Parts): string {
  const head = Buffer.from(phase1Qr(phase1), 'base64');
  const tail = [
    ...tlvField(6, utf8(parts.xmlHashHex)),
    ...tlvField(7, utf8(parts.signatureB64)),
    ...tlvField(8, parts.publicKeyDer),
    ...tlvField(9, parts.certSignatureDer),
  ];
  return toBase64(Uint8Array.from([...head, ...tail]));
}

// ── self-signed certificates (tests and local sandbox only) ─────────────────

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const out: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest % 256);
  return [0x80 | out.length, ...out];
}

function der(tag: number, content: readonly number[] | Uint8Array): number[] {
  return [tag, ...derLength(content.length), ...content];
}

const ECDSA_SHA256 = der(0x30, der(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));

function name(cn: string): number[] {
  return der(
    0x30,
    der(0x31, der(0x30, [...der(0x06, [0x55, 0x04, 0x03]), ...der(0x0c, utf8(cn))])),
  );
}

function utcTime(at: Date): number[] {
  const text = at.toISOString().replace(/[-:T]/gu, '').slice(2, 14);
  return der(0x17, utf8(`${text}Z`));
}

export interface SelfSignedInput {
  readonly privateKeyPem: string;
  readonly issuerCn: string;
  readonly subjectCn: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Positive serial, e.g. 1. */
  readonly serial?: number;
}

/**
 * A self-signed X.509 v3 certificate (PEM) for the given EC key — for tests and a local sandbox,
 * never for production: ZATCA issues the real CSID. Dates must fall in 1950–2049 (UTCTime).
 */
export function selfSignedCertificate(input: SelfSignedInput): string {
  const key = createPrivateKey(input.privateKeyPem);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const serial = input.serial ?? 1;
  const tbs = der(0x30, [
    ...der(0xa0, der(0x02, [0x02])),
    ...der(0x02, [serial & 0x7f]),
    ...ECDSA_SHA256,
    ...name(input.issuerCn),
    ...der(0x30, [...utcTime(input.notBefore), ...utcTime(input.notAfter)]),
    ...name(input.subjectCn),
    ...spki,
  ]);
  const signature = nodeSign('sha256', Uint8Array.from(tbs), key);
  const cert = der(0x30, [...tbs, ...ECDSA_SHA256, ...der(0x03, [0x00, ...signature])]);
  const body = (
    Buffer.from(cert)
      .toString('base64')
      .match(/.{1,64}/gu) ?? []
  ).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
