import { authorize, uuidv7 } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';
import { uploadObjectKey } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type {
  SignatureRequestRow,
  SignatureRequestSignerRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import type { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { maskEmail } from '../public-links/public-links.service.js';
import { RECORD_SCHEMA, verifyRecord } from './approval-records.js';
import type { DecisionEvidence, EsignEvidence } from './approval-records.js';
import {
  ApprovalRecordRaceError,
  ApprovalRecordsRepository,
} from './approval-records.repository.js';
import { ClientProjectionsRepository } from './client-projections.repository.js';
import { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import {
  CODE_MAX_ATTEMPTS,
  CODE_RESEND_MS,
  CODE_TTL_MS,
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  codeSendRefusal,
  codeUnusable,
  conflict,
  invalid,
  markSha256,
  parseCreateInput,
  parseSignatureInput,
  requestState,
  signerState,
} from './esign.js';
import type {
  PortalSignatureListView,
  PortalSignatureView,
  SignatureCodeSentView,
  SignatureRequestListView,
  SignatureRequestView,
  SignatureSignerView,
} from './esign.js';
import { EsignRepository } from './esign.repository.js';
import type { SignerWithContact } from './esign.repository.js';

const DAY_MS = 24 * 60 * 60_000;

export interface EsignOptions {
  readonly database: TenantDatabase;
  readonly secrets: PublicLinkSecrets;
  readonly store: ObjectStore;
  readonly mailer: Mailer | null;
  /** The web app's public origin, for the link in the request e-mail. */
  readonly webPublicUrl: string | null;
  readonly signer?: AnchorSigner;
  readonly now?: () => Date;
}

/** A refusal is returned from the transaction, not thrown, so a counted wrong code commits. */
type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

/**
 * 52-26 — simple electronic signature. The team asks named client contacts to sign one exact
 * deliverable version; each contact signs in the portal with a typed name or a drawn mark, the
 * consent sentence and a one-time e-mail code; the signature is sealed into the 52-19 approval
 * record chain.
 *
 * Every id from a request is resolved inside the caller's tenant context. A client acts only
 * through their OWN signer row (`user_id = principal.userId`, same client organization) on a
 * project they can read; anything else is the same 404 as an unknown request.
 */
export class EsignService {
  private readonly anchor: AnchorSigner;
  private readonly now: () => Date;

  constructor(
    private readonly options: EsignOptions,
    private readonly repo: EsignRepository = new EsignRepository(),
    private readonly versions: DeliverableVersionsRepository = new DeliverableVersionsRepository(),
    private readonly projections: ClientProjectionsRepository = new ClientProjectionsRepository(),
    private readonly records: ApprovalRecordsRepository = new ApprovalRecordsRepository(),
  ) {
    this.anchor = options.signer ?? AnchorSigner.fromEnv(process.env);
    this.now = options.now ?? (() => new Date());
  }

  // ── the team ───────────────────────────────────────────────────────────────

  async create(
    context: TenantContext,
    principal: Principal,
    body: Readonly<Record<string, unknown>>,
  ): Promise<SignatureRequestView> {
    const input = parseCreateInput(body);
    const at = this.now();
    const { view, mails, organization } = await this.options.database.transaction(
      context,
      async (tx) => {
        const version = await this.versions.findById(tx, context, input.deliverableVersionId);
        if (version === null) throw notFound();
        this.staff(context, principal, version.projectId, 'deliverable.publish');
        const projection = await this.projections.findByVersion(tx, context, version.id);
        if (projection === null) throw conflict('not_published');
        const contacts = await this.repo.contacts(
          tx,
          context,
          version.projectId,
          input.signerUserIds,
        );
        const byUser = new Map(contacts.map((c) => [c.userId, c]));
        const named = input.signerUserIds.flatMap((id) => {
          const contact = byUser.get(id);
          return contact === undefined ? [] : [contact];
        });
        if (named.length !== input.signerUserIds.length) {
          throw invalid('signerUserIds', 'only client contacts on this project');
        }
        const request: SignatureRequestRow = {
          id: uuidv7(),
          organizationId: context.organizationId,
          projectId: version.projectId,
          deliverableId: version.deliverableId,
          deliverableVersionId: version.id,
          contentHash: version.contentHash,
          title: input.title ?? projection.projection.title,
          status: 'pending',
          expiresAt: new Date(at.getTime() + input.expiresInDays * DAY_MS),
          createdBy: principal.userId,
          createdAt: at,
          completedAt: null,
          cancelledAt: null,
          remindedAt: null,
        };
        const signers = named.map((contact, i): SignatureRequestSignerRow => ({
          ...emptySigner(),
          id: uuidv7(),
          organizationId: context.organizationId,
          requestId: request.id,
          userId: contact.userId,
          clientOrganizationId: contact.clientOrganizationId,
          createdAt: new Date(at.getTime() + i),
        }));
        await this.repo.insert(tx, request, signers);
        return {
          view: await this.view(tx, context, request, at),
          mails: named.map((c) => c.email),
          organization: await this.repo.organization(tx, context),
        };
      },
    );
    await this.mailRequest(organization, mails, view.title, view.id);
    return view;
  }

  async list(
    context: TenantContext,
    principal: Principal,
    deliverableVersionId: unknown,
  ): Promise<SignatureRequestListView> {
    if (typeof deliverableVersionId !== 'string' || deliverableVersionId === '') {
      throw invalid('deliverableVersionId', 'is required');
    }
    const at = this.now();
    return this.options.database.read(context, async (runner) => {
      const version = await this.versions.findById(runner, context, deliverableVersionId);
      if (version === null) throw notFound();
      this.staff(context, principal, version.projectId, 'approval.read');
      const rows = await this.repo.listForVersion(runner, context, version.id);
      const requests: SignatureRequestView[] = [];
      for (const row of rows) requests.push(await this.view(runner, context, row, at));
      return { requests };
    });
  }

  async get(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<SignatureRequestView> {
    const at = this.now();
    return this.options.database.read(context, async (runner) => {
      const request = await this.repo.findRequest(runner, context, requestId);
      if (request === null) throw notFound();
      this.staff(context, principal, request.projectId, 'approval.read');
      return this.view(runner, context, request, at);
    });
  }

  async cancel(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<SignatureRequestView> {
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const request = await this.repo.findRequest(tx, context, requestId, true);
      if (request === null) throw notFound();
      this.staff(context, principal, request.projectId, 'deliverable.publish');
      if (request.status !== 'pending') throw conflict(request.status);
      await this.repo.updatePendingRequest(tx, context, request.id, {
        status: 'cancelled',
        cancelledAt: at,
      });
      return this.view(tx, context, { ...request, status: 'cancelled', cancelledAt: at }, at);
    });
  }

  /** E-mail the signers who have not signed. Once a day at most. */
  async remind(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<SignatureRequestView> {
    const at = this.now();
    const { view, mails, organization } = await this.options.database.transaction(
      context,
      async (tx) => {
        const request = await this.repo.findRequest(tx, context, requestId, true);
        if (request === null) throw notFound();
        this.staff(context, principal, request.projectId, 'deliverable.publish');
        if (requestState(request, at) !== 'pending') throw conflict(requestState(request, at));
        if (request.remindedAt !== null && at.getTime() - request.remindedAt.getTime() < DAY_MS) {
          throw new ApiError(429, 'rate_limited', 'A reminder was already sent today.');
        }
        await this.repo.updatePendingRequest(tx, context, request.id, { remindedAt: at });
        const signers = await this.repo.signers(tx, context, request.id);
        return {
          view: await this.view(tx, context, { ...request, remindedAt: at }, at),
          mails: signers.filter((s) => s.signer.status === 'pending').map((s) => s.email),
          organization: await this.repo.organization(tx, context),
        };
      },
    );
    await this.mailRequest(organization, mails, view.title, view.id);
    return view;
  }

  // ── the signer (portal) ────────────────────────────────────────────────────

  async listMine(context: TenantContext, principal: Principal): Promise<PortalSignatureListView> {
    const at = this.now();
    return this.options.database.read(context, async (runner) => {
      const rows = await this.repo.listForUser(runner, context, principal.userId);
      const organizationName = (await this.repo.organization(runner, context)).name;
      const requests: PortalSignatureView[] = [];
      for (const { request, signer } of rows) {
        if (!this.clientMay(context, principal, request, signer)) continue;
        requests.push(
          await this.portalView(runner, context, request, signer, organizationName, at),
        );
      }
      return { requests };
    });
  }

  async getMine(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<PortalSignatureView> {
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const { request, signer } = await this.mine(tx, context, principal, requestId);
      const seen = signer.viewedAt ?? at;
      if (signer.viewedAt === null)
        await this.repo.updateSigner(tx, context, signer.id, { viewedAt: at });
      const organizationName = (await this.repo.organization(tx, context)).name;
      return this.portalView(
        tx,
        context,
        request,
        { ...signer, viewedAt: seen },
        organizationName,
        at,
      );
    });
  }

  /** Mail a fresh 6-digit code to the signer's own address. Once a minute, five an hour. */
  async sendCode(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<SignatureCodeSentView> {
    const at = this.now();
    const { email, code } = await this.options.database.transaction(context, async (tx) => {
      const { request, signer } = await this.mine(tx, context, principal, requestId, true);
      const state = signerState(request, signer, at);
      if (state !== 'pending') throw conflict(state === 'signed' ? 'already_signed' : state);
      const window = codeSendRefusal(signer, at);
      if (window.refused !== null) throw window.refused;
      const issued = this.options.secrets.issueCode(signer.id);
      await this.repo.updateSigner(tx, context, signer.id, {
        codeHash: issued.hash,
        codeExpiresAt: new Date(at.getTime() + CODE_TTL_MS),
        codeAttempts: 0,
        codeSentAt: at,
        codeWindowStartedAt: window.windowStart,
        codesInWindow: window.inWindow,
      });
      const own = (await this.repo.signers(tx, context, request.id)).find(
        (s) => s.signer.id === signer.id,
      );
      return { email: own?.email ?? '', code: issued.code };
    });
    if (this.options.mailer !== null && email !== '') {
      await this.options.mailer.send({
        to: email,
        subject: `Your TManage signature code: ${code}`,
        text:
          `Your code to sign the document is ${code}.\n\n` +
          'It works for 10 minutes. If you did not ask to sign a document, you can ignore this message.',
      });
    }
    return {
      emailHint: maskEmail(email) ?? '',
      expiresInSeconds: CODE_TTL_MS / 1_000,
      resendAfterSeconds: CODE_RESEND_MS / 1_000,
    };
  }

  /**
   * Sign: consent, the code (a wrong one is counted and committed), the pinned SHA-256 re-checked
   * against the version, the drawn mark stored privately, and one sealed record in the 52-19 chain.
   */
  async sign(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    body: Readonly<Record<string, unknown>>,
    evidence: DecisionEvidence,
  ): Promise<PortalSignatureView> {
    const input = parseSignatureInput(body);
    const at = this.now();
    let outcome: Outcome<PortalSignatureView>;
    try {
      outcome = await this.options.database.transaction(context, async (tx) => {
        const { request, signer } = await this.mine(tx, context, principal, requestId, true);
        const state = signerState(request, signer, at);
        if (state !== 'pending')
          return failed(conflict(state === 'signed' ? 'already_signed' : state));
        const unusable = codeUnusable(signer, at);
        if (unusable !== null) return failed(invalid('code', unusable));
        if (!this.options.secrets.codeMatches(signer.id, input.code, signer.codeHash ?? '')) {
          const attempts = signer.codeAttempts + 1;
          await this.repo.updateSigner(tx, context, signer.id, { codeAttempts: attempts });
          return failed(
            invalid('code', attempts >= CODE_MAX_ATTEMPTS ? 'code_locked' : 'code_wrong'),
          );
        }
        const version = await this.versions.findById(tx, context, request.deliverableVersionId);
        if (version === null || version.contentHash !== request.contentHash) {
          return failed(conflict('document_changed'));
        }
        const own = (await this.repo.signers(tx, context, request.id)).find(
          (s) => s.signer.id === signer.id,
        );
        if (own === undefined) return failed(notFound());
        const markHash = input.mark === null ? null : markSha256(input.mark);
        const markKey =
          input.mark === null ? null : await this.storeMark(context, request, signer, input.mark);
        const record = await this.records.appendEsign(
          tx,
          context,
          {
            schema: RECORD_SCHEMA,
            projectId: request.projectId,
            approvalId: request.id,
            deliverableId: request.deliverableId,
            deliverableVersionId: request.deliverableVersionId,
            versionNo: version.versionNo,
            fileVersionId: version.fileVersionId,
            contentHash: request.contentHash,
            approver: {
              userId: principal.userId,
              membershipId: principal.membershipId,
              kind: 'client',
              role: principal.role,
              clientOrganizationId: principal.clientOrganizationId,
            },
            decision: 'signed',
            comment: null,
            decidedAt: at.toISOString(),
            ip: evidence.ip,
            userAgent: evidence.userAgent,
            esign: {
              requestId: request.id,
              signerId: signer.id,
              signerEmail: own.email,
              signerName: own.displayName,
              method: input.method,
              typedName: input.typedName,
              markSha256: markHash,
              consentTextVersion: CONSENT_TEXT_VERSION,
              consentText: CONSENT_TEXT,
              codeVerifiedAt: at.toISOString(),
            },
          },
          this.anchor,
        );
        const signed: SignatureRequestSignerRow = {
          ...signer,
          status: 'signed',
          signedAt: at,
          method: input.method,
          typedName: input.typedName,
          markObjectKey: markKey,
          markSha256: markHash,
          recordId: record.id,
          codeHash: null,
          codeExpiresAt: null,
          codeVerifiedAt: at,
        };
        await this.repo.updateSigner(tx, context, signer.id, {
          status: signed.status,
          signedAt: signed.signedAt,
          method: signed.method,
          typedName: signed.typedName,
          markObjectKey: signed.markObjectKey,
          markSha256: signed.markSha256,
          recordId: signed.recordId,
          codeHash: null,
          codeExpiresAt: null,
          codeVerifiedAt: at,
        });
        const all = await this.repo.signers(tx, context, request.id);
        if (all.every((s) => s.signer.status === 'signed' || s.signer.id === signer.id)) {
          await this.repo.updatePendingRequest(tx, context, request.id, {
            status: 'completed',
            completedAt: at,
          });
        }
        const organizationName = (await this.repo.organization(tx, context)).name;
        return succeeded(await this.portalView(tx, context, request, signed, organizationName, at));
      });
    } catch (error) {
      if (error instanceof ApprovalRecordRaceError) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'approval_record_race');
      }
      throw error;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Staff only, with `capability` on the request's project; anything else is a 404. */
  private staff(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
  ): void {
    const allowed =
      principal.kind !== 'client' &&
      authorize({
        principal,
        capability,
        resource: {
          organizationId: context.organizationId,
          projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;
    if (!allowed) throw notFound();
  }

  /** A client may see a request only on a project they can read, through their own signer row. */
  private clientMay(
    context: TenantContext,
    principal: Principal,
    request: SignatureRequestRow,
    signer: SignatureRequestSignerRow,
  ): boolean {
    return (
      principal.kind === 'client' &&
      signer.userId === principal.userId &&
      signer.clientOrganizationId === principal.clientOrganizationId &&
      authorize({
        principal,
        capability: 'client_projection.read',
        resource: {
          organizationId: context.organizationId,
          projectId: request.projectId,
          audience: 'client_visible',
          clientOrganizationId: principal.clientOrganizationId,
          lifecycle: 'active',
        },
      }).allowed
    );
  }

  private async mine(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    requestId: string,
    forUpdate = false,
  ): Promise<{
    readonly request: SignatureRequestRow;
    readonly signer: SignatureRequestSignerRow;
  }> {
    const request = await this.repo.findRequest(runner, context, requestId, forUpdate);
    const signer =
      request === null
        ? null
        : await this.repo.findSigner(runner, context, request.id, principal.userId, forUpdate);
    if (
      request === null ||
      signer === null ||
      !this.clientMay(context, principal, request, signer)
    ) {
      throw notFound();
    }
    return { request, signer };
  }

  /** The drawn mark, as a private object under the tenant prefix — never under the web root. */
  private async storeMark(
    context: TenantContext,
    request: SignatureRequestRow,
    signer: SignatureRequestSignerRow,
    mark: Buffer,
  ): Promise<string> {
    const objectKey = uploadObjectKey({
      organizationId: context.organizationId,
      projectId: request.projectId,
      uploadId: signer.id,
    });
    const promotion = await this.options.store.promote({ objectKey, sizeBytes: mark.length });
    try {
      await new Promise<void>((resolve, reject) => {
        promotion.sink.write(mark, (error) => (error ? reject(error) : resolve()));
      });
      await promotion.commit();
    } catch (error) {
      await promotion.abort();
      throw error;
    }
    return objectKey;
  }

  private async portalView(
    runner: TenantQueryRunner,
    context: TenantContext,
    request: SignatureRequestRow,
    signer: SignatureRequestSignerRow,
    organizationName: string,
    at: Date,
  ): Promise<PortalSignatureView> {
    const version = await this.versions.findById(runner, context, request.deliverableVersionId);
    const own = (await this.repo.signers(runner, context, request.id)).find(
      (s) => s.signer.id === signer.id,
    );
    return {
      id: request.id,
      title: request.title,
      projectId: request.projectId,
      deliverableVersionId: request.deliverableVersionId,
      fileVersionId: version?.fileVersionId ?? null,
      organizationName,
      state: signerState(request, signer, at),
      signedAt: signer.signedAt?.toISOString() ?? null,
      expiresAt: request.expiresAt.toISOString(),
      emailHint: maskEmail(own?.email ?? null) ?? '',
      codeLive:
        signer.codeHash !== null &&
        signer.codeExpiresAt !== null &&
        signer.codeExpiresAt.getTime() > at.getTime() &&
        signer.codeAttempts < CODE_MAX_ATTEMPTS,
      signerName: own?.displayName ?? '',
      consentText: CONSENT_TEXT,
      consentTextVersion: CONSENT_TEXT_VERSION,
    };
  }

  private async view(
    runner: TenantQueryRunner,
    context: TenantContext,
    request: SignatureRequestRow,
    at: Date,
  ): Promise<SignatureRequestView> {
    const version = await this.versions.findById(runner, context, request.deliverableVersionId);
    const signers = await this.repo.signers(runner, context, request.id);
    const recordRows = await this.repo.records(
      runner,
      context,
      signers.flatMap((s) => (s.signer.recordId === null ? [] : [s.signer.recordId])),
    );
    const previous = await this.records.hashesByNumber(
      runner,
      context,
      recordRows.map((r) => r.recordNo - 1).filter((n) => n > 0),
    );
    const recordViews = new Map(
      recordRows.map((row) => {
        const check = verifyRecord(row, previous.get(row.recordNo - 1) ?? null, this.anchor);
        const sealed = JSON.parse(row.recordJson) as EsignEvidence;
        return [
          row.id,
          {
            recordNo: row.recordNo,
            recordHash: row.recordHash,
            intact: check.hashValid && check.chainValid && check.signatureValid !== false,
            email: sealed.esign.signerEmail,
            method: sealed.esign.method,
            typedName: sealed.esign.typedName,
            codeVerifiedAt: sealed.esign.codeVerifiedAt,
            signedAt: sealed.decidedAt,
            ip: sealed.ip,
            userAgent: sealed.userAgent,
            contentHash: sealed.contentHash,
            consentTextVersion: sealed.esign.consentTextVersion,
          },
        ] as const;
      }),
    );
    const signerViews = signers.map((s: SignerWithContact): SignatureSignerView => ({
      id: s.signer.id,
      userId: s.signer.userId,
      displayName: s.displayName,
      clientOrganizationName: s.clientOrganizationName,
      status: s.signer.status,
      viewedAt: s.signer.viewedAt?.toISOString() ?? null,
      signedAt: s.signer.signedAt?.toISOString() ?? null,
      record: s.signer.recordId === null ? null : (recordViews.get(s.signer.recordId) ?? null),
    }));
    return {
      id: request.id,
      title: request.title,
      projectId: request.projectId,
      deliverableId: request.deliverableId,
      deliverableVersionId: request.deliverableVersionId,
      contentHash: request.contentHash,
      documentUnchanged: version !== null && version.contentHash === request.contentHash,
      state: requestState(request, at),
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
      signedCount: signerViews.filter((s) => s.status === 'signed').length,
      signers: signerViews,
    };
  }

  private async mailRequest(
    organization: { readonly name: string; readonly slug: string },
    to: readonly string[],
    title: string,
    requestId: string,
  ): Promise<void> {
    if (this.options.mailer === null) return;
    const base = this.options.webPublicUrl?.replace(/\/+$/u, '') ?? null;
    const link = base === null ? '' : `\n\n${base}/${organization.slug}/portal/sign/${requestId}`;
    for (const address of to) {
      await this.options.mailer.send({
        to: address,
        subject: `${organization.name} asked you to sign ${title}`,
        text: `${organization.name} asked you to sign "${title}" in your client portal.${link}`,
      });
    }
  }
}

function emptySigner(): Omit<
  SignatureRequestSignerRow,
  'id' | 'organizationId' | 'requestId' | 'userId' | 'clientOrganizationId' | 'createdAt'
> {
  return {
    status: 'pending',
    codeHash: null,
    codeExpiresAt: null,
    codeAttempts: 0,
    codeSentAt: null,
    codeWindowStartedAt: null,
    codesInWindow: 0,
    codeVerifiedAt: null,
    viewedAt: null,
    signedAt: null,
    method: null,
    typedName: null,
    markObjectKey: null,
    markSha256: null,
    recordId: null,
  };
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function failed<T>(error: ApiError): Outcome<T> {
  return { ok: false, error };
}

function succeeded<T>(value: T): Outcome<T> {
  return { ok: true, value };
}
