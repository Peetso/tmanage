import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  memberPhotoRemovals,
  memberships,
  userAvatars,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PhotoSize } from './profile-photo-image.js';

/**
 * Profile photo (0411) — the person's own photo (`user_avatars`, GLOBAL like `users`) and a company's
 * removal of it (`member_photo_removals`, tenant-owned). Every statement on the tenant tables carries
 * `organization_id = context.organizationId`; the user id of an own-photo statement is always the
 * signed-in principal's, never a body field. The image columns are read only by {@link findImage}.
 */
export interface OwnPhotoRow {
  readonly sha256: string;
  readonly updatedAt: Date;
}

export interface PhotoImageRow {
  readonly sha256: string;
  readonly imageBase64: string;
}

/** One person of this company who has a photo, with how they belong to it. */
export interface PhotoCandidateRow {
  readonly userId: string;
  readonly sha256: string;
  readonly internalMember: boolean;
  readonly clientOrganizationIds: readonly string[];
  /** The person's membership ids here: the internal one and each client contact one. */
  readonly membershipIds: readonly string[];
}

export interface StoredPhotoInput {
  readonly sha256: string;
  readonly image256Base64: string;
  readonly image64Base64: string;
}

export class ProfilePhotoRepository {
  async findOwn(runner: TenantQueryRunner, userId: string): Promise<OwnPhotoRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({ sha256: userAvatars.sha256, updatedAt: userAvatars.updatedAt })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findImage(
    runner: TenantQueryRunner,
    userId: string,
    size: PhotoSize,
  ): Promise<PhotoImageRow | null> {
    const column = size === 256 ? userAvatars.image256Base64 : userAvatars.image64Base64;
    const rows = await tenantDrizzle(runner)
      .select({ sha256: userAvatars.sha256, imageBase64: column })
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create or replace — one statement on the primary key, so two uploads serialise on it (DA-1). */
  async upsert(
    runner: TenantQueryRunner,
    userId: string,
    input: StoredPhotoInput,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(userAvatars)
      .values({ userId, ...input, createdAt: now, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { ...input, updatedAt: now } });
  }

  /** Remove the own photo. Idempotent. */
  async remove(runner: TenantQueryRunner, userId: string): Promise<void> {
    await tenantDrizzle(runner).delete(userAvatars).where(eq(userAvatars.userId, userId));
  }

  /** The digest of the photo this company removed for this person, or null. */
  async findRemoval(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ photoSha256: memberPhotoRemovals.photoSha256 })
      .from(memberPhotoRemovals)
      .where(
        and(
          eq(memberPhotoRemovals.organizationId, context.organizationId),
          eq(memberPhotoRemovals.userId, userId),
        ),
      )
      .limit(1);
    return rows[0]?.photoSha256 ?? null;
  }

  async listRemovals(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, string>> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberPhotoRemovals.userId, photoSha256: memberPhotoRemovals.photoSha256 })
      .from(memberPhotoRemovals)
      .where(eq(memberPhotoRemovals.organizationId, context.organizationId));
    return new Map(rows.map((row) => [row.userId, row.photoSha256] as const));
  }

  /** Record (or move to this photo) this company's removal; one row per person per company. */
  async upsertRemoval(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    photoSha256: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(memberPhotoRemovals)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        userId,
        photoSha256,
        removedBy: context.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { photoSha256, removedBy: context.userId, updatedAt: now } });
  }

  /**
   * Everyone in this company who has a photo — active members and active client contacts — with
   * how they belong. `userId` narrows it to one person (the image route and the admin removal).
   */
  async listCandidates(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId?: string,
  ): Promise<readonly PhotoCandidateRow[]> {
    const db = tenantDrizzle(runner);
    const internal = await db
      .select({ id: memberships.id, userId: memberships.userId, sha256: userAvatars.sha256 })
      .from(memberships)
      .innerJoin(userAvatars, eq(userAvatars.userId, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          userId === undefined ? undefined : eq(memberships.userId, userId),
        ),
      );
    const client = await db
      .select({
        id: clientMemberships.id,
        userId: clientMemberships.userId,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        sha256: userAvatars.sha256,
      })
      .from(clientMemberships)
      .innerJoin(userAvatars, eq(userAvatars.userId, clientMemberships.userId))
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.status, 'active'),
          userId === undefined ? undefined : eq(clientMemberships.userId, userId),
        ),
      );
    const byUser = new Map<
      string,
      {
        sha256: string;
        internalMember: boolean;
        clientOrganizationIds: string[];
        membershipIds: string[];
      }
    >();
    for (const row of internal) {
      byUser.set(row.userId, {
        sha256: row.sha256,
        internalMember: true,
        clientOrganizationIds: [],
        membershipIds: [row.id],
      });
    }
    for (const row of client) {
      const entry = byUser.get(row.userId) ?? {
        sha256: row.sha256,
        internalMember: false,
        clientOrganizationIds: [],
        membershipIds: [],
      };
      entry.clientOrganizationIds.push(row.clientOrganizationId);
      entry.membershipIds.push(row.id);
      byUser.set(row.userId, entry);
    }
    return [...byUser.entries()].map(([id, entry]) => ({ userId: id, ...entry }));
  }
}
