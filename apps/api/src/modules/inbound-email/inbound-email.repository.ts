import { and, desc, eq, gte, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  inboundEmailAddresses,
  inboundEmailAttachments,
  inboundEmails,
  memberships,
  organizations,
  projectClients,
  projects,
  users,
} from '../../common/database/schema.js';
import type {
  InboundEmailAddressRow,
  InboundEmailAttachmentRow,
  InboundEmailRow,
} from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { SenderClient, SenderMember } from './inbound-mail-rules.js';

/**
 * R21-f (54-12 / 54-12a, 0312) — storage for `inbound_email_addresses`, `inbound_emails` and
 * `inbound_email_attachments`. Every statement carries the caller context's `organization_id`
 * except {@link InboundEmailRepository.findAddressByLocalPart}: the ingest's one pre-context read,
 * on `bootstrapRead(['inbound_email_addresses'])` (reason `inbound_email_address_lookup`), which
 * returns the row whose organization every later statement is then bound to.
 */

export interface NewInboundEmail {
  readonly id: string;
  readonly addressId: string;
  readonly messageIdHash: string;
  readonly fromEmail: string;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly authResult: string;
  readonly outcome: string;
  readonly outcomeReason: string | null;
  readonly linkedObjectType: string | null;
  readonly linkedObjectId: string | null;
  readonly droppedAttachments: number;
}

export interface NewInboundAttachment {
  readonly id: string;
  readonly inboundEmailId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  readonly state: string;
  /** R22-c: set only when the bytes were parked in the quarantine zone. */
  readonly sha256?: string | null;
}

export interface LogCursor {
  readonly receivedAt: Date;
  readonly id: string;
}

export class InboundEmailRepository {
  async findAddressByLocalPart(
    runner: BootstrapQueryRunner,
    localPart: string,
  ): Promise<InboundEmailAddressRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboundEmailAddresses)
      .where(eq(inboundEmailAddresses.localPart, localPart))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The organization's active address (at most one by the service's rule). */
  async findActiveAddress(
    runner: TenantQueryRunner,
    context: TenantContext,
    forUpdate = false,
  ): Promise<InboundEmailAddressRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(inboundEmailAddresses)
      .where(
        and(
          eq(inboundEmailAddresses.organizationId, context.organizationId),
          eq(inboundEmailAddresses.status, 'active'),
        ),
      )
      .orderBy(desc(inboundEmailAddresses.createdAt))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** EMAILBUILD (c): the workspace's name and language, for the ask-resend mail's [WS] sign-off. */
  async organizationLabel(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly name: string; readonly defaultLocale: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ name: organizations.name, defaultLocale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findAddressById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InboundEmailAddressRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboundEmailAddresses)
      .where(
        and(
          eq(inboundEmailAddresses.organizationId, context.organizationId),
          eq(inboundEmailAddresses.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertAddress(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly id: string;
      readonly localPart: string;
      readonly defaultProjectId: string | null;
      readonly policyJson: string;
    },
    at: Date,
  ): Promise<InboundEmailAddressRow> {
    await tenantDrizzle(runner).insert(inboundEmailAddresses).values({
      id: input.id,
      organizationId: context.organizationId,
      localPart: input.localPart,
      status: 'active',
      defaultProjectId: input.defaultProjectId,
      policyJson: input.policyJson,
      createdAt: at,
    });
    const row = await this.findAddressById(runner, context, input.id);
    if (!row) throw new Error(`inbound address ${input.id} vanished after insert`);
    return row;
  }

  async markRotated(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(inboundEmailAddresses)
      .set({ status: 'rotated', rotatedAt: at })
      .where(
        and(
          eq(inboundEmailAddresses.organizationId, context.organizationId),
          eq(inboundEmailAddresses.id, id),
        ),
      );
  }

  async findByMessageHash(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageIdHash: string,
  ): Promise<{ readonly id: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.organizationId, context.organizationId),
          eq(inboundEmails.messageIdHash, messageIdHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertEmail(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewInboundEmail,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner).insert(inboundEmails).values({
      id: input.id,
      organizationId: context.organizationId,
      addressId: input.addressId,
      messageIdHash: input.messageIdHash,
      fromEmail: input.fromEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      authResult: input.authResult,
      outcome: input.outcome,
      outcomeReason: input.outcomeReason,
      linkedObjectType: input.linkedObjectType,
      linkedObjectId: input.linkedObjectId,
      droppedAttachments: input.droppedAttachments,
      receivedAt: at,
    });
  }

  async findEmail(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    forUpdate = false,
  ): Promise<InboundEmailRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(inboundEmails)
      .where(
        and(eq(inboundEmails.organizationId, context.organizationId), eq(inboundEmails.id, id)),
      )
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async markTrusted(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: {
      readonly trustedBy: string;
      readonly outcome: string;
      readonly outcomeReason: string | null;
      readonly linkedObjectType: string | null;
      readonly linkedObjectId: string | null;
    },
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(inboundEmails)
      .set({
        trustedBy: input.trustedBy,
        trustedAt: at,
        outcome: input.outcome,
        outcomeReason: input.outcomeReason,
        linkedObjectType: input.linkedObjectType,
        linkedObjectId: input.linkedObjectId,
      })
      .where(
        and(eq(inboundEmails.organizationId, context.organizationId), eq(inboundEmails.id, id)),
      );
  }

  /** Newest first, keyset on `(received_at, id)`. Never selects the body. */
  async listEmails(
    runner: TenantQueryRunner,
    context: TenantContext,
    cursor: LogCursor | null,
    limit: number,
  ): Promise<readonly Omit<InboundEmailRow, 'bodyText'>[]> {
    const scope = eq(inboundEmails.organizationId, context.organizationId);
    const page =
      cursor === null
        ? scope
        : and(
            scope,
            or(
              lt(inboundEmails.receivedAt, cursor.receivedAt),
              and(eq(inboundEmails.receivedAt, cursor.receivedAt), lt(inboundEmails.id, cursor.id)),
            ),
          );
    return tenantDrizzle(runner)
      .select({
        id: inboundEmails.id,
        organizationId: inboundEmails.organizationId,
        addressId: inboundEmails.addressId,
        messageIdHash: inboundEmails.messageIdHash,
        fromEmail: inboundEmails.fromEmail,
        subject: inboundEmails.subject,
        authResult: inboundEmails.authResult,
        outcome: inboundEmails.outcome,
        outcomeReason: inboundEmails.outcomeReason,
        linkedObjectType: inboundEmails.linkedObjectType,
        linkedObjectId: inboundEmails.linkedObjectId,
        droppedAttachments: inboundEmails.droppedAttachments,
        trustedBy: inboundEmails.trustedBy,
        trustedAt: inboundEmails.trustedAt,
        receivedAt: inboundEmails.receivedAt,
      })
      .from(inboundEmails)
      .where(page)
      .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.id))
      .limit(limit);
  }

  async insertAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly NewInboundAttachment[],
    at: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tenantDrizzle(runner)
      .insert(inboundEmailAttachments)
      .values(
        rows.map((row) => ({
          id: row.id,
          organizationId: context.organizationId,
          inboundEmailId: row.inboundEmailId,
          name: row.name,
          sizeBytes: row.sizeBytes,
          declaredType: row.declaredType,
          sha256: row.sha256 ?? null,
          state: row.state,
          createdAt: at,
          updatedAt: at,
        })),
      );
  }

  async listAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    emailIds: readonly string[],
  ): Promise<readonly InboundEmailAttachmentRow[]> {
    if (emailIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(inboundEmailAttachments)
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          inArray(inboundEmailAttachments.inboundEmailId, [...emailIds]),
        ),
      )
      .orderBy(inboundEmailAttachments.createdAt, inboundEmailAttachments.id);
  }

  /**
   * 54-12a / R22-c: trusting a mail turns its `waiting_trust` attachments `unavailable` — their
   * bytes were dropped unwritten (rule 5) and a pushed mail has no mailbox to re-fetch from, so the
   * honest state is "ask the sender to re-send". (R21-f moved them to `scanning`, with no bytes.)
   */
  async expireWaitingAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    emailId: string,
    at: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ id: inboundEmailAttachments.id })
      .from(inboundEmailAttachments)
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eq(inboundEmailAttachments.inboundEmailId, emailId),
          eq(inboundEmailAttachments.state, 'waiting_trust'),
        ),
      );
    if (rows.length === 0) return 0;
    await this.markUnavailable(runner, context, emailId, at);
    return rows.length;
  }

  /** `waiting_trust` rows of one mail -> `unavailable`. */
  async markUnavailable(
    runner: TenantQueryRunner,
    context: TenantContext,
    emailId: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(inboundEmailAttachments)
      .set({ state: 'unavailable', updatedAt: at })
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eq(inboundEmailAttachments.inboundEmailId, emailId),
          eq(inboundEmailAttachments.state, 'waiting_trust'),
        ),
      );
  }

  /**
   * R22-c — 54-12a rule (6): attachment bytes this organization took in since `dayStart` (UTC),
   * not counting rows refused as `blocked_type` / `too_large`.
   */
  async dailyAttachmentBytes(
    runner: TenantQueryRunner,
    context: TenantContext,
    dayStart: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ total: sql<string | number | null>`sum(${inboundEmailAttachments.sizeBytes})` })
      .from(inboundEmailAttachments)
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          gte(inboundEmailAttachments.createdAt, dayStart),
          notInArray(inboundEmailAttachments.state, ['blocked_type', 'too_large']),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /** R22-c: the outcome after the work item was (or could not be) created. */
  async setOutcome(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: {
      readonly outcome: string;
      readonly outcomeReason: string | null;
      readonly linkedObjectType: string | null;
      readonly linkedObjectId: string | null;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(inboundEmails)
      .set(input)
      .where(
        and(eq(inboundEmails.organizationId, context.organizationId), eq(inboundEmails.id, id)),
      );
  }

  /**
   * R22-c: the sender as an internal member of THIS organization — `users.email` (lower-cased
   * exact match) joined to an `active` `memberships` row of the organization. `null` otherwise
   * (a member of another organization included).
   */
  async findSenderMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    email: string,
  ): Promise<SenderMember | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId, membershipId: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          // The hidden Support-session membership is not a sender.
          ne(memberships.role, 'platform_support'),
          eq(sql`lower(${users.email})`, email.toLowerCase()),
        ),
      )
      .orderBy(memberships.id)
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The sender as a client user of THIS organization: `users.email` (lower-cased exact match)
   * joined to an active `client_memberships` row of the organization. `null` for anybody else.
   */
  async findSenderClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    email: string,
  ): Promise<SenderClient | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        clientOrganizationId: clientMemberships.clientOrganizationId,
        userId: clientMemberships.userId,
      })
      .from(clientMemberships)
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.status, 'active'),
          eq(sql`lower(${users.email})`, email.toLowerCase()),
        ),
      )
      .orderBy(clientMemberships.id)
      .limit(1);
    return rows[0] ?? null;
  }

  /** The project is this organization's, not archived. */
  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id, archivedAt: projects.archivedAt })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows[0] !== undefined && rows[0].archivedAt === null;
  }

  /** The project is shared with the client organization (`project_clients`). */
  async isProjectShared(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projectClients.id })
      .from(projectClients)
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          eq(projectClients.projectId, projectId),
          eq(projectClients.clientOrganizationId, clientOrganizationId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
