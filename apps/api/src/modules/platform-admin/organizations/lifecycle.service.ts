import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import { requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { PlatformOrganizationsRepository } from './organizations.repository.js';
import type { OrgRow } from './organizations.repository.js';
import type {
  PlatformOrganizationsService,
  PlatformOrgWriteView,
} from './organizations.service.js';

/**
 * Platform admin · Organizations · Lifecycle (A7, A9; SPEC §6, P7). Every act here is on the
 * destructive list: a reason is required, and delete, transfer and purge also need the slug typed
 * exactly. Nothing hard-deletes from the screen: delete is a soft delete with a restore window
 * (`retention.org_purge_days`, 30 by default); purge only brings `purge_after` forward to now and
 * the worker's organization purge hands it to the privacy erasure path. Purge is the super admin
 * preset's alone.
 */

export interface TypedSlugInput {
  readonly confirmSlug?: unknown;
  readonly reason?: unknown;
}

export interface TransferInput extends TypedSlugInput {
  readonly newOwnerMembershipId?: unknown;
}

/** The role a former owner keeps after a transfer. */
export const FORMER_OWNER_ROLE = 'org_admin';

/** 400 unless the typed slug matches exactly (case and all). */
export function requireTypedSlug(raw: unknown, slug: string): void {
  if (typeof raw !== 'string' || raw.trim() !== slug) {
    throw new ApiError(
      400,
      'validation_failed',
      'Type the organization’s slug exactly to confirm.',
      [{ field: 'confirmSlug', message: 'must match' }],
    );
  }
}

/** Super admins only: the bootstrap list, or the super admin preset. */
export function isSuperAdmin(actor: Pick<PlatformAdminActor, 'source' | 'preset'>): boolean {
  return actor.source === 'env' || actor.preset === 'super_admin';
}

function conflict(message: string): ApiError {
  return new ApiError(409, 'conflict', message);
}

export class PlatformOrganizationLifecycleService {
  constructor(
    private readonly organizations: PlatformOrganizationsService,
    private readonly orgs: PlatformOrganizationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService | null,
  ) {}

  async suspend(
    actor: PlatformAdminActor,
    rawId: unknown,
    suspend: boolean,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const row = await this.organizations.require(rawId, context);
    if (row.deletedAt) throw conflict('This organization is deleted. Restore it first.');
    await this.organizations.setSuspended(actor, row.id, suspend, body ?? {}, context);
    return this.organizations.written(row.id, context);
  }

  async remove(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: TypedSlugInput,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    requireTypedSlug(body?.confirmSlug, row.slug);
    if (row.deletedAt) throw conflict('This organization is already deleted.');
    const days = await this.organizations.retentionDays(context);
    const done = await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_deleted', reason, { retentionDays: days }),
      (tx) => PlatformOrganizationsRepository.softDelete(tx, row.id, days, actor.account.userId),
    );
    if (!done) throw conflict('This organization is already deleted.');
    return this.organizations.written(row.id, context);
  }

  async restore(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    if (!row.deletedAt) throw conflict('This organization is not deleted.');
    if (row.archivedAt) throw conflict('This organization was purged and cannot be restored.');
    const done = await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_restored', reason),
      (tx) => PlatformOrganizationsRepository.restore(tx, row.id),
    );
    if (!done) throw conflict('This organization can no longer be restored.');
    return this.organizations.written(row.id, context);
  }

  async purge(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: TypedSlugInput,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    if (!isSuperAdmin(actor)) {
      throw new ApiError(403, 'forbidden', 'Only a super admin can purge an organization.', [
        { field: 'permission', message: 'platform.orgs.purge' },
      ]);
    }
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    requireTypedSlug(body?.confirmSlug, row.slug);
    if (!row.deletedAt) throw conflict('Delete the organization before purging it.');
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_purge_requested', reason),
      (tx) => PlatformOrganizationsRepository.purgeNow(tx, row.id),
    );
    return this.organizations.written(row.id, context);
  }

  async archive(
    actor: PlatformAdminActor,
    rawId: unknown,
    on: boolean,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    if (row.deletedAt) throw conflict('This organization is deleted. Restore it first.');
    if (on === (row.archivedAt !== null)) {
      throw conflict(
        on ? 'This organization is already archived.' : 'This organization is not archived.',
      );
    }
    const done = await this.orgs.write(
      row.id,
      audit(
        actor,
        context,
        row,
        on ? 'platform.organization_archived' : 'platform.organization_unarchived',
        reason,
      ),
      (tx) => PlatformOrganizationsRepository.archive(tx, row.id, on),
    );
    if (!done) throw conflict('This organization was erased and stays archived.');
    return this.organizations.written(row.id, context);
  }

  async policyRefresh(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_policy_refreshed', reason),
      (tx) => PlatformOrganizationsRepository.policyRefresh(tx, row.id),
    );
    return this.organizations.written(row.id, context);
  }

  /**
   * Make an active internal member the owner; every other owner becomes an org admin. One
   * transaction: the new owner, the demotions, their audit rows and the platform row.
   */
  async transfer(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: TransferInput,
    context: RequestContext,
  ): Promise<PlatformOrgWriteView> {
    const reason = requireReason(body?.reason);
    const row = await this.organizations.require(rawId, context);
    requireTypedSlug(body?.confirmSlug, row.slug);
    if (row.deletedAt || row.archivedAt)
      throw conflict('Restore or unarchive the organization first.');
    const newOwnerId =
      typeof body?.newOwnerMembershipId === 'string' ? body.newOwnerMembershipId : '';
    if (newOwnerId === '') {
      throw new ApiError(400, 'validation_failed', 'Choose the new owner.', [
        { field: 'newOwnerMembershipId', message: 'required' },
      ]);
    }
    await this.orgs.write(
      row.id,
      audit(actor, context, row, 'platform.organization_ownership_transferred', reason, {
        newOwnerMembershipId: newOwnerId,
      }),
      async (tx, tenant) => {
        const target = await this.memberships.findById(tx, tenant, newOwnerId);
        if (!target || target.status !== 'active' || target.role === 'platform_support') {
          throw new ApiError(404, 'not_found', MESSAGES.notFound);
        }
        if (target.role === 'owner') throw conflict('This person is already an owner.');
        const owners = await this.orgs
          .members(row.id, context.correlationId)
          .then((m) =>
            m.internal.filter((member) => member.role === 'owner' && member.status === 'active'),
          );
        await this.memberships.changeRole(tx, tenant, target.id, target.version, 'owner');
        await this.audit?.record(tx, tenant, {
          action: 'membership.role_changed',
          objectId: target.id,
          result: 'allowed',
          actorUserId: null,
          effectiveActorId: actor.account.userId,
          metadata: { target_user_id: target.userId, via: 'platform_admin' },
          changes: [{ field: 'role', before: target.role, after: 'owner' }],
        });
        for (const owner of owners) {
          if (owner.id === target.id) continue;
          await this.memberships.changeRole(tx, tenant, owner.id, owner.version, FORMER_OWNER_ROLE);
          await this.audit?.record(tx, tenant, {
            action: 'membership.role_changed',
            objectId: owner.id,
            result: 'allowed',
            actorUserId: null,
            effectiveActorId: actor.account.userId,
            metadata: { target_user_id: owner.userId, via: 'platform_admin' },
            changes: [{ field: 'role', before: 'owner', after: FORMER_OWNER_ROLE }],
          });
        }
      },
    );
    return this.organizations.written(row.id, context);
  }
}

function audit(
  actor: PlatformAdminActor,
  context: RequestContext,
  row: OrgRow,
  action: string,
  reason: string,
  after?: Record<string, unknown>,
) {
  return {
    ...platformAuditFor(actor, context, {
      action,
      targetType: 'organization' as const,
      targetId: row.id,
      targetLabel: row.name,
      organizationId: row.id,
      reason,
    }),
    ...(after ? { afterJson: JSON.stringify(after) } : {}),
  };
}
