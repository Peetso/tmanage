import { authorize, uuidv7 } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import {
  FieldCipherError,
  createFieldCipher,
  loadFieldCipherKeyring,
} from '@tmanage/domain/field-cipher';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import {
  SigningMaterialError,
  certificateSignatureDer,
  checkSigningMaterial,
  publicKeyDer,
  signXml,
  verifyXmlSignature,
} from '@tmanage/domain/zatca-sign';
import type { CertificateFacts } from '@tmanage/domain/zatca-sign';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { verifyReauthToken } from '../identity/reauth-token.js';
import type { OrgSecretMetaRow, OrgSecretsRepository } from './org-secrets.repository.js';

/**
 * 52-12 (R22-a) — the ZATCA signing certificate: stored, replaced and revoked here, and the ONE
 * place that decrypts it.
 *
 * ## Key handling (52-12 Security, critical)
 *
 * The certificate PEM and the private key PEM are stored together as one FieldCipher envelope
 * (purpose `org_secret`, AAD owner = the `org_secrets` row id) — never in plaintext; keyless
 * (`FIELD_CIPHER_KEYS` unset) the PUT is a 409 rather than a plaintext fallback. The decrypted
 * key lives only inside {@link EinvoiceSigningService.signDocument}: callers get a signature and
 * a fingerprint, never a PEM. `meta_json` holds the certificate's public facts (and, for the
 * Phase-2 QR, its public key and its CA signature — both public), so a status read or a QR
 * rebuild never decrypts. Error messages are fixed strings and audit metadata carries the
 * fingerprint only.
 *
 * ## Authorization
 *
 * Reading the status: `finance.manage`. Storing, replacing, revoking: `org.security.manage` plus a
 * fresh step-up (`x-reauth-token` from `POST /v1/auth/reauth`, bound to this session) — a missing
 * or stale token is 403 `reauthentication_required` / `step_up_required`. Internal principals
 * only.
 */

export const ZATCA_SIGNING_SECRET = 'zatca_signing';
const PURPOSE = 'org_secret' as const;
const FINANCE_MANAGE: Capability = 'finance.manage';
const SECURITY_MANAGE: Capability = 'org.security.manage';

/** What `meta_json` holds: public facts only. */
export interface SigningCertificateMeta {
  readonly issuer: string;
  readonly subject: string;
  readonly serial: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly fingerprint256: string;
  readonly sandbox: boolean;
  readonly publicKeyPem: string;
  /** Base64 SubjectPublicKeyInfo DER (QR tag 8). */
  readonly publicKeyDerB64: string;
  /** Base64 of the certificate's CA signature (QR tag 9). */
  readonly certSignatureB64: string;
}

export interface CertificateStatusView {
  readonly id: string;
  readonly status: string;
  readonly issuer: string;
  readonly subject: string;
  readonly serial: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly fingerprint: string;
  /** "test certificate (sandbox)" — the issuer is a ZATCA sandbox CA. */
  readonly sandbox: boolean;
  readonly expired: boolean;
  readonly createdAt: string;
}

export interface DocumentSignature {
  readonly signature: string;
  readonly fingerprint: string;
}

/** Why a document could not be signed — a code, never key or certificate text. */
export class SigningFailure extends Error {
  constructor(public readonly code: string) {
    super(`signing failed: ${code}`);
    this.name = 'SigningFailure';
  }
}

export interface StepUpMeta {
  readonly reauthToken?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface EinvoiceSigningServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: OrgSecretsRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly cipher?: FieldCipher;
  readonly sessionSecret?: string;
  readonly now?: () => Date;
}

const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);

function metaOf(row: Pick<OrgSecretMetaRow, 'metaJson'>): SigningCertificateMeta {
  return JSON.parse(row.metaJson) as SigningCertificateMeta;
}

function rejectionOf(error: SigningMaterialError): ApiError {
  const keyReasons: readonly string[] = [
    'invalid_key',
    'unsupported_curve',
    'certificate_key_mismatch',
  ];
  const field = keyReasons.includes(error.reason) ? 'privateKeyPem' : 'certificatePem';
  return new ApiError(422, 'validation_failed', error.reason, [{ field, message: error.reason }]);
}

function validateBody(body: unknown): { certificatePem: string; privateKeyPem: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const details = (['certificatePem', 'privateKeyPem'] as const)
    .filter((field) => typeof input[field] !== 'string' || (input[field] as string).length > 20_000)
    .map((field) => ({ field, message: 'must be a PEM string' }));
  if (details.length > 0)
    throw new ApiError(422, 'validation_failed', 'invalid_certificate_body', details);
  return {
    certificatePem: input['certificatePem'] as string,
    privateKeyPem: input['privateKeyPem'] as string,
  };
}

export class EinvoiceSigningService {
  private readonly now: () => Date;
  private readonly cipher: FieldCipher;

  constructor(private readonly options: EinvoiceSigningServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.cipher = options.cipher ?? createFieldCipher(loadFieldCipherKeyring(process.env));
  }

  private get repo(): OrgSecretsRepository {
    return this.options.repository;
  }

  // ---- the certificate (controller) ----

  /**
   * The active signing certificate's status, or `null` when the organization has none yet (fix
   * lane B 2026-11-23, AI-ACTIONS-LIVE-TEST fix 9): "no certificate" is the empty state of a
   * settings read, not a missing resource, so it is a 200 `null` rather than a 404 the AI (and any
   * client) must tell apart from a wrong URL. No web caller relied on the 404.
   */
  async certificate(
    context: TenantContext,
    principal: Principal,
  ): Promise<CertificateStatusView | null> {
    this.require(principal, context, FINANCE_MANAGE, 'org_secret.view');
    return this.options.database.read(context, async (r) => {
      const row = (await this.repo.listMeta(r, context.organizationId, ZATCA_SIGNING_SECRET)).find(
        (candidate) => candidate.status === 'active',
      );
      return row === undefined ? null : this.statusView(row);
    });
  }

  async replace(
    context: TenantContext,
    principal: Principal,
    body: unknown,
    meta: StepUpMeta,
  ): Promise<CertificateStatusView> {
    this.require(principal, context, SECURITY_MANAGE, 'org_secret.manage');
    this.requireStepUp(context, meta);
    const input = validateBody(body);
    const at = this.now();
    let facts: CertificateFacts;
    try {
      facts = checkSigningMaterial(input.certificatePem, input.privateKeyPem, at);
    } catch (error) {
      if (error instanceof SigningMaterialError) throw rejectionOf(error);
      throw error;
    }
    if (!this.cipher.enabled) {
      throw new ApiError(409, 'conflict', 'encryption_unavailable', [
        { field: 'certificatePem', message: 'encryption_unavailable' },
      ]);
    }
    const metaJson: SigningCertificateMeta = {
      issuer: facts.issuer,
      subject: facts.subject,
      serial: facts.serial,
      notBefore: facts.notBefore,
      notAfter: facts.notAfter,
      fingerprint256: facts.fingerprint256,
      sandbox: facts.sandbox,
      publicKeyPem: facts.publicKeyPem,
      publicKeyDerB64: Buffer.from(publicKeyDer(facts.publicKeyPem)).toString('base64'),
      certSignatureB64: Buffer.from(certificateSignatureDer(input.certificatePem)).toString(
        'base64',
      ),
    };
    const org = context.organizationId;
    return this.options.database.transaction(context, async (tx) => {
      const previous = await this.repo.findActive(tx, org, ZATCA_SIGNING_SECRET, true);
      if (previous !== null) await this.repo.markStatus(tx, org, previous.id, 'rotated', at);
      const id = uuidv7();
      const row = {
        id,
        organizationId: org,
        secretKey: ZATCA_SIGNING_SECRET,
        ciphertext: this.cipher.encrypt(
          JSON.stringify({
            certificatePem: input.certificatePem,
            privateKeyPem: input.privateKeyPem,
          }),
          { purpose: PURPOSE, ownerId: id },
        ),
        keyVersion: this.cipher.activeKeyId(PURPOSE),
        metaJson: JSON.stringify(metaJson),
        status: 'active',
        createdBy: context.userId,
        createdAt: at,
        rotatedAt: null,
      };
      await this.repo.insert(tx, row);
      await this.options.audit.record(tx, context, {
        action: 'org_secret.certificate_replaced',
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: {
          fingerprint: facts.fingerprint256,
          sandbox: facts.sandbox,
          replaced: previous !== null,
        },
        changes: [],
      });
      return this.statusView(row);
    });
  }

  async revoke(context: TenantContext, principal: Principal, meta: StepUpMeta): Promise<void> {
    this.require(principal, context, SECURITY_MANAGE, 'org_secret.manage');
    this.requireStepUp(context, meta);
    const org = context.organizationId;
    const at = this.now();
    await this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findActive(tx, org, ZATCA_SIGNING_SECRET, true);
      if (row === null) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.repo.markStatus(tx, org, row.id, 'revoked', at);
      await this.options.audit.record(tx, context, {
        action: 'org_secret.certificate_revoked',
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: { fingerprint: metaOf(row).fingerprint256 },
        changes: [],
      });
    });
  }

  // ---- signing (client-invoices.service, inside the send / credit-note transaction) ----

  /**
   * Signs the XML with the organization's active certificate and verifies the signature with the
   * certificate's public key. `null` when there is no active certificate (the document goes out
   * `ready`, as before); throws {@link SigningFailure} with a code on any failure.
   */
  async signDocument(
    runner: TenantQueryRunner,
    organizationId: string,
    xml: string,
  ): Promise<DocumentSignature | null> {
    const row = await this.repo.findActive(runner, organizationId, ZATCA_SIGNING_SECRET);
    if (row === null) return null;
    const meta = metaOf(row);
    let material: { certificatePem: string; privateKeyPem: string };
    try {
      material = JSON.parse(
        this.cipher.decrypt(row.ciphertext, { purpose: PURPOSE, ownerId: row.id }),
      ) as { certificatePem: string; privateKeyPem: string };
    } catch (error) {
      throw new SigningFailure(
        error instanceof FieldCipherError ? `decrypt_${error.reason}` : 'decrypt_failed',
      );
    }
    let signature: string;
    try {
      checkSigningMaterial(material.certificatePem, material.privateKeyPem, this.now());
      signature = signXml(xml, material.privateKeyPem);
    } catch (error) {
      throw new SigningFailure(
        error instanceof SigningMaterialError ? error.reason : 'sign_failed',
      );
    }
    if (!verifyXmlSignature(xml, signature, meta.publicKeyPem)) {
      throw new SigningFailure('verify_failed');
    }
    return { signature, fingerprint: meta.fingerprint256 };
  }

  /** The public facts of the certificate with this fingerprint (active or rotated), for the QR. */
  async certificateFor(
    runner: TenantQueryRunner,
    organizationId: string,
    fingerprint: string,
  ): Promise<SigningCertificateMeta | null> {
    const row = await this.repo.findByFingerprint(
      runner,
      organizationId,
      ZATCA_SIGNING_SECRET,
      fingerprint,
    );
    return row === null ? null : metaOf(row);
  }

  // ---- helpers ----

  private statusView(
    row: Pick<OrgSecretMetaRow, 'id' | 'status' | 'metaJson' | 'createdAt'>,
  ): CertificateStatusView {
    const meta = metaOf(row);
    return {
      id: row.id,
      status: row.status,
      issuer: meta.issuer,
      subject: meta.subject,
      serial: meta.serial,
      notBefore: meta.notBefore,
      notAfter: meta.notAfter,
      fingerprint: meta.fingerprint256,
      sandbox: meta.sandbox,
      expired: Date.parse(meta.notAfter) < this.now().getTime(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private require(
    principal: Principal,
    context: TenantContext,
    capability: Capability,
    code: string,
  ): void {
    if (principal.kind !== 'internal') throw forbidden('org_secret.internal_only');
    const allowed = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!allowed) throw forbidden(code);
  }

  private requireStepUp(context: TenantContext, meta: StepUpMeta): void {
    const secret = this.options.sessionSecret;
    const fresh =
      secret !== undefined &&
      meta.reauthToken !== undefined &&
      meta.sessionId !== undefined &&
      ((verified) =>
        verified.ok &&
        verified.claims.userId === context.userId &&
        verified.claims.sessionId === meta.sessionId)(
        verifyReauthToken(meta.reauthToken, secret, this.now().getTime()),
      );
    if (!fresh) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'step_up_required',
        [{ field: 'x-reauth-token', message: 'step_up_required' }],
        'org_secret.step_up',
      );
    }
  }
}
