import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  integrationChannelLinks,
  integrationChannelPosts,
  integrationConnections,
  projects,
} from '../../common/database/schema.js';
import type {
  ChannelLinkKind,
  IntegrationChannelLinkRow,
  IntegrationConnectionRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R15-c (54-05 / 54-06 Phase 0) — storage for `integration_channel_links` and the test-post half
 * of `integration_channel_posts` (0289). Every statement carries the `organization_id` from the
 * caller's context; no input names an organization.
 */

export interface NewChannelLink {
  readonly id: string;
  readonly connectionId: string;
  readonly kind: ChannelLinkKind;
  readonly projectId: string | null;
  readonly externalChannelId: string;
  readonly label: string | null;
  readonly webhookUrlEnc: string;
  readonly urlHost: string;
  readonly events: readonly string[];
  readonly locale: string;
  readonly createdBy: string;
}

const MAX_LINKS_LISTED = 200;

export class ChannelLinksRepository {
  /** The org's connection row for `appId` ('slack' | 'teams'), oldest first. */
  async findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    appId: string,
  ): Promise<IntegrationConnectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, context.organizationId),
          eq(integrationConnections.appId, appId),
        ),
      )
      .orderBy(asc(integrationConnections.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly IntegrationChannelLinkRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(integrationChannelLinks)
      .where(eq(integrationChannelLinks.organizationId, context.organizationId))
      .orderBy(desc(integrationChannelLinks.id))
      .limit(MAX_LINKS_LISTED);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<IntegrationChannelLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(integrationChannelLinks)
      .where(
        and(
          eq(integrationChannelLinks.organizationId, context.organizationId),
          eq(integrationChannelLinks.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The same channel already linked for the same scope (a NULL project never hits the UNIQUE). */
  async findDuplicate(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    externalChannelId: string,
    projectId: string | null,
  ): Promise<IntegrationChannelLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(integrationChannelLinks)
      .where(
        and(
          eq(integrationChannelLinks.organizationId, context.organizationId),
          eq(integrationChannelLinks.connectionId, connectionId),
          eq(integrationChannelLinks.externalChannelId, externalChannelId),
          projectId === null
            ? isNull(integrationChannelLinks.projectId)
            : eq(integrationChannelLinks.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewChannelLink,
    at: Date,
  ): Promise<IntegrationChannelLinkRow> {
    await tenantDrizzle(runner)
      .insert(integrationChannelLinks)
      .values({
        id: input.id,
        organizationId: context.organizationId,
        connectionId: input.connectionId,
        kind: input.kind,
        projectId: input.projectId,
        externalChannelId: input.externalChannelId,
        externalChannelLabel: input.label,
        webhookUrlEnc: input.webhookUrlEnc,
        urlHost: input.urlHost,
        eventsJson: JSON.stringify(input.events),
        locale: input.locale,
        status: 'active',
        failureStreak: 0,
        createdBy: input.createdBy,
        createdAt: at,
        updatedAt: at,
      });
    const row = await this.findById(runner, context, input.id);
    if (!row) throw new Error(`channel link ${input.id} vanished after insert`);
    return row;
  }

  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(integrationChannelLinks)
      .where(
        and(
          eq(integrationChannelLinks.organizationId, context.organizationId),
          eq(integrationChannelLinks.id, id),
        ),
      );
    return result[0].affectedRows;
  }

  /** FIX5. Every link of `kind` posting through host `urlHost` (the bot links of one provider). */
  async removeByHost(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ChannelLinkKind,
    urlHost: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(integrationChannelLinks)
      .where(
        and(
          eq(integrationChannelLinks.organizationId, context.organizationId),
          eq(integrationChannelLinks.kind, kind),
          eq(integrationChannelLinks.urlHost, urlHost),
        ),
      );
    return result[0].affectedRows;
  }

  /** Back to `active` with the breaker's streak cleared. */
  async resume(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<IntegrationChannelLinkRow | null> {
    await tenantDrizzle(runner)
      .update(integrationChannelLinks)
      .set({ status: 'active', failureStreak: 0, pausedReason: null, updatedAt: at })
      .where(
        and(
          eq(integrationChannelLinks.organizationId, context.organizationId),
          eq(integrationChannelLinks.id, id),
        ),
      );
    return this.findById(runner, context, id);
  }

  /** When the link's last test post was staged, or null. */
  async lastTestPostAt(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    testKind: string,
  ): Promise<Date | null> {
    const rows = await tenantDrizzle(runner)
      .select({ createdAt: integrationChannelPosts.createdAt })
      .from(integrationChannelPosts)
      .where(
        and(
          eq(integrationChannelPosts.organizationId, context.organizationId),
          eq(integrationChannelPosts.linkId, linkId),
          eq(integrationChannelPosts.eventKind, testKind),
        ),
      )
      .orderBy(desc(integrationChannelPosts.createdAt))
      .limit(1);
    return rows[0]?.createdAt ?? null;
  }

  async stageTestPost(
    runner: TenantQueryRunner,
    context: TenantContext,
    link: Pick<IntegrationChannelLinkRow, 'id' | 'locale'>,
    testKind: string,
    at: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(integrationChannelPosts).values({
      id,
      organizationId: context.organizationId,
      linkId: link.id,
      outboxEventId: null,
      eventKind: testKind,
      locale: link.locale,
      status: 'staged',
      attempt: 1,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }
}
