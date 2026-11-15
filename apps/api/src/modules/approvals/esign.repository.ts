import { and, desc, eq, inArray, isNull, gt, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  approvalRecords,
  clientMemberships,
  clientOrganizations,
  organizations,
  projectClients,
  signatureRequestSigners,
  signatureRequests,
  users,
} from '../../common/database/schema.js';
import type {
  ApprovalRecordRow,
  SignatureRequestRow,
  SignatureRequestSignerRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-26 — every statement on `signature_requests` and `signature_request_signers` (0354). Every
 * method takes the runner and the context first; the tenant predicate is on every statement and
 * the guard (`drizzle.ts`) refuses one without it. Ids from a request are only ever compared
 * inside a statement already bound to `context.organizationId`.
 */

/** A client contact who may be named as a signer on a project, with the address the code goes to. */
export interface SignerContact {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
}

/** A signer row with the person's name, address and client organization, for the views. */
export interface SignerWithContact {
  readonly signer: SignatureRequestSignerRow;
  readonly email: string;
  readonly displayName: string;
  readonly clientOrganizationName: string;
}

const MAX_LIST = 50;

export class EsignRepository {
  /** The project's active client contacts among `userIds` (the only people a request may name). */
  async contacts(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    userIds: readonly string[],
  ): Promise<readonly SignerContact[]> {
    return tenantDrizzle(runner)
      .selectDistinct({
        userId: clientMemberships.userId,
        email: users.email,
        displayName: users.displayName,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        clientOrganizationName: clientOrganizations.name,
      })
      .from(clientMemberships)
      .innerJoin(
        projectClients,
        and(
          eq(projectClients.organizationId, clientMemberships.organizationId),
          eq(projectClients.clientOrganizationId, clientMemberships.clientOrganizationId),
        ),
      )
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(projectClients.projectId, projectId),
          inArray(clientMemberships.userId, [...userIds]),
          eq(clientMemberships.status, 'active'),
          or(isNull(clientMemberships.expiresAt), gt(clientMemberships.expiresAt, sql`NOW(3)`)),
        ),
      );
  }

  async insert(
    runner: TenantQueryRunner,
    request: SignatureRequestRow,
    signers: readonly SignatureRequestSignerRow[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db.insert(signatureRequests).values(request);
    await db.insert(signatureRequestSigners).values([...signers]);
  }

  async findRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    forUpdate = false,
  ): Promise<SignatureRequestRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(signatureRequests)
      .where(
        and(
          eq(signatureRequests.organizationId, context.organizationId),
          eq(signatureRequests.id, requestId),
        ),
      )
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async listForVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<readonly SignatureRequestRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(signatureRequests)
      .where(
        and(
          eq(signatureRequests.organizationId, context.organizationId),
          eq(signatureRequests.deliverableVersionId, deliverableVersionId),
        ),
      )
      .orderBy(desc(signatureRequests.createdAt))
      .limit(MAX_LIST);
  }

  /** The requests addressed to one person, newest first, each with that person's signer row. */
  async listForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<
    readonly { readonly request: SignatureRequestRow; readonly signer: SignatureRequestSignerRow }[]
  > {
    return tenantDrizzle(runner)
      .select({ request: signatureRequests, signer: signatureRequestSigners })
      .from(signatureRequestSigners)
      .innerJoin(
        signatureRequests,
        and(
          eq(signatureRequests.organizationId, signatureRequestSigners.organizationId),
          eq(signatureRequests.id, signatureRequestSigners.requestId),
        ),
      )
      .where(
        and(
          eq(signatureRequestSigners.organizationId, context.organizationId),
          eq(signatureRequestSigners.userId, userId),
        ),
      )
      .orderBy(desc(signatureRequests.createdAt))
      .limit(MAX_LIST);
  }

  /** The caller's own signer row on a request — the only row a client may act through. */
  async findSigner(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    userId: string,
    forUpdate = false,
  ): Promise<SignatureRequestSignerRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(signatureRequestSigners)
      .where(
        and(
          eq(signatureRequestSigners.organizationId, context.organizationId),
          eq(signatureRequestSigners.requestId, requestId),
          eq(signatureRequestSigners.userId, userId),
        ),
      )
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async signers(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
  ): Promise<readonly SignerWithContact[]> {
    return tenantDrizzle(runner)
      .select({
        signer: signatureRequestSigners,
        email: users.email,
        displayName: users.displayName,
        clientOrganizationName: clientOrganizations.name,
      })
      .from(signatureRequestSigners)
      .innerJoin(users, eq(users.id, signatureRequestSigners.userId))
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, signatureRequestSigners.organizationId),
          eq(clientOrganizations.id, signatureRequestSigners.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(signatureRequestSigners.organizationId, context.organizationId),
          eq(signatureRequestSigners.requestId, requestId),
        ),
      )
      .orderBy(signatureRequestSigners.createdAt);
  }

  async updateSigner(
    runner: TenantQueryRunner,
    context: TenantContext,
    signerId: string,
    patch: Partial<
      Pick<
        SignatureRequestSignerRow,
        | 'codeHash'
        | 'codeExpiresAt'
        | 'codeAttempts'
        | 'codeSentAt'
        | 'codeWindowStartedAt'
        | 'codesInWindow'
        | 'codeVerifiedAt'
        | 'viewedAt'
        | 'status'
        | 'signedAt'
        | 'method'
        | 'typedName'
        | 'markObjectKey'
        | 'markSha256'
        | 'recordId'
      >
    >,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(signatureRequestSigners)
      .set(patch)
      .where(
        and(
          eq(signatureRequestSigners.organizationId, context.organizationId),
          eq(signatureRequestSigners.id, signerId),
        ),
      );
  }

  /** Move a pending request on (complete, cancel) or stamp a reminder. Pending rows only. */
  async updatePendingRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    patch: Partial<
      Pick<SignatureRequestRow, 'status' | 'completedAt' | 'cancelledAt' | 'remindedAt'>
    >,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(signatureRequests)
      .set(patch)
      .where(
        and(
          eq(signatureRequests.organizationId, context.organizationId),
          eq(signatureRequests.id, requestId),
          eq(signatureRequests.status, 'pending'),
        ),
      );
  }

  /** The sealed records of a request's signers, by id. */
  async records(
    runner: TenantQueryRunner,
    context: TenantContext,
    recordIds: readonly string[],
  ): Promise<readonly ApprovalRecordRow[]> {
    if (recordIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(approvalRecords)
      .where(
        and(
          eq(approvalRecords.organizationId, context.organizationId),
          inArray(approvalRecords.id, [...recordIds]),
        ),
      );
  }

  /** The organization's name and slug, for the portal heading and the e-mail link. */
  async organization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly name: string; readonly slug: string }> {
    const rows = await tenantDrizzle(runner)
      .select({ name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0] ?? { name: '', slug: '' };
  }
}
