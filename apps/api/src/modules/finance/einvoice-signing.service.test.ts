import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { selfSignedCertificate } from '@tmanage/domain/zatca-sign';
import type { OrgSecretRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { signReauthToken } from '../identity/reauth-token.js';
import { EinvoiceSigningService, SigningFailure } from './einvoice-signing.service.js';
import type { OrgSecretsRepository } from './org-secrets.repository.js';

/**
 * 52-12 (R22-a) INT-52-24 / SEC-52-06 over an in-memory `org_secrets`: the PUT guard (role and
 * step-up), the curve and key-match refusals, the envelope at rest, no PEM in the audit trail,
 * sandbox detection, sign + verify, rotate and revoke.
 */

const ORG = '00000000-0000-7000-8000-000000000001';
const SECRET = 'session-secret-for-tests';
const SESSION = 'sess1';
const NOW = new Date('2026-11-02T09:00:00Z');
const context = { organizationId: ORG, userId: 'u1' } as TenantContext;
const principal = (role: string, kind = 'internal'): Principal =>
  ({
    userId: 'u1',
    organizationId: ORG,
    kind,
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  }) as unknown as Principal;
const owner = principal('owner');
const stepUp = {
  reauthToken: signReauthToken(
    { userId: 'u1', sessionId: SESSION, expiresAt: new Date(NOW.getTime() + 60_000) },
    SECRET,
  ),
  sessionId: SESSION,
};

function keyPem(curve = 'secp256k1'): string {
  return generateKeyPairSync('ec', { namedCurve: curve })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

function certPem(privateKeyPem: string, issuerCn = 'TManage Test CA'): string {
  return selfSignedCertificate({
    privateKeyPem,
    issuerCn,
    subjectCn: 'Studio',
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
  });
}

function signingWorld() {
  const rows: OrgSecretRow[] = [];
  const repository = {
    findActive: async (_r: unknown, org: string, key: string) =>
      rows.find((r) => r.organizationId === org && r.secretKey === key && r.status === 'active') ??
      null,
    insert: async (_r: unknown, row: OrgSecretRow) => {
      rows.push({ ...row });
    },
    markStatus: async (_r: unknown, _o: string, id: string, status: string, at: Date) => {
      Object.assign(
        rows.find((r) => r.id === id)!,
        { status, rotatedAt: at },
      );
    },
    listMeta: async () => [...rows].reverse(),
    findByFingerprint: async (_r: unknown, _o: string, _k: string, fp: string) =>
      rows.find(
        (r) => (JSON.parse(r.metaJson) as { fingerprint256: string }).fingerprint256 === fp,
      ) ?? null,
  } as unknown as OrgSecretsRepository;
  const record = vi.fn(async () => undefined);
  const transaction = async (_c: unknown, work: (r: unknown) => unknown) => work({});
  const cipher = createFieldCipher(
    loadFieldCipherKeyring({ FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}` }),
  );
  const service = new EinvoiceSigningService({
    database: { transaction, read: transaction } as never,
    repository,
    audit: { record } as never,
    cipher,
    sessionSecret: SECRET,
    now: () => NOW,
  });
  return { service, rows, record };
}

describe('52-12 ZATCA signing certificate (R22-a)', () => {
  it('PUT needs org.security.manage and a fresh step-up; a client is refused', async () => {
    const w = signingWorld();
    const key = keyPem();
    const body = { certificatePem: certPem(key), privateKeyPem: key };
    await expect(w.service.replace(context, owner, body, {})).rejects.toMatchObject({
      status: 403,
      message: 'step_up_required',
    });
    await expect(
      w.service.replace(context, principal('workspace_admin'), body, stepUp),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(
      w.service.certificate(context, principal('client_admin', 'client')),
    ).rejects.toMatchObject({ status: 403 });
    expect(w.rows).toHaveLength(0);
  });

  it('refuses a P-256 key and a key that is not the certificate’s', async () => {
    const w = signingWorld();
    const p256 = keyPem('prime256v1');
    await expect(
      w.service.replace(
        context,
        owner,
        { certificatePem: certPem(p256), privateKeyPem: p256 },
        stepUp,
      ),
    ).rejects.toMatchObject({ status: 422, message: 'unsupported_curve' });
    await expect(
      w.service.replace(
        context,
        owner,
        { certificatePem: certPem(keyPem()), privateKeyPem: keyPem() },
        stepUp,
      ),
    ).rejects.toMatchObject({ status: 422, message: 'certificate_key_mismatch' });
  });

  it('SEC-52-06: stores an fc1 envelope, never a PEM in audit; sandbox issuer; signs, rotates, revokes', async () => {
    const w = signingWorld();
    const key = keyPem();
    const view = await w.service.replace(
      context,
      owner,
      { certificatePem: certPem(key, 'PRZEINVOICESCA4-PREZATCA-CA'), privateKeyPem: key },
      stepUp,
    );
    expect(view).toMatchObject({ status: 'active', sandbox: true, expired: false });
    expect(w.rows[0]!.ciphertext.startsWith('fc1.org_secret.')).toBe(true);
    expect(w.rows[0]!.metaJson).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(w.record.mock.calls)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(w.record.mock.calls)).toContain(view.fingerprint);
    expect((await w.service.certificate(context, owner)).fingerprint).toBe(view.fingerprint);

    const signed = await w.service.signDocument({} as never, ORG, '<Invoice/>');
    expect(signed?.fingerprint).toBe(view.fingerprint);
    expect((await w.service.certificateFor({} as never, ORG, view.fingerprint))?.sandbox).toBe(
      true,
    );

    w.rows[0]!.ciphertext = `${w.rows[0]!.ciphertext.slice(0, -4)}AAAA`;
    await expect(w.service.signDocument({} as never, ORG, '<Invoice/>')).rejects.toBeInstanceOf(
      SigningFailure,
    );

    const next = keyPem();
    await w.service.replace(
      context,
      owner,
      { certificatePem: certPem(next), privateKeyPem: next },
      stepUp,
    );
    expect(w.rows.map((r) => r.status)).toEqual(['rotated', 'active']);
    await w.service.revoke(context, owner, stepUp);
    expect(w.rows.map((r) => r.status)).toEqual(['rotated', 'revoked']);
    expect(await w.service.signDocument({} as never, ORG, '<Invoice/>')).toBeNull();
    await expect(w.service.certificate(context, owner)).rejects.toMatchObject({ status: 404 });
  });
});
