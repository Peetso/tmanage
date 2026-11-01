import { and, eq, inArray, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { linkPreviews, messages } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** What the worker unfurled for one message's first link (R7 slice 5). */
export interface LinkPreviewView {
  readonly messageId: string;
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
  readonly status: 'pending' | 'ready' | 'failed';
}

/**
 * The read half of `link_previews`; the worker writes the rows. Tenant-scoped, and joined to the
 * message so an id from another conversation (or a removed message) reads as no preview.
 */
export class LinkPreviewsRepository {
  async listForMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<LinkPreviewView[]> {
    if (messageIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        messageId: linkPreviews.messageId,
        url: linkPreviews.url,
        title: linkPreviews.title,
        description: linkPreviews.description,
        imageUrl: linkPreviews.imageUrl,
        siteName: linkPreviews.siteName,
        status: linkPreviews.status,
      })
      .from(linkPreviews)
      .innerJoin(
        messages,
        and(
          eq(messages.organizationId, linkPreviews.organizationId),
          eq(messages.id, linkPreviews.messageId),
        ),
      )
      .where(
        and(
          eq(linkPreviews.organizationId, context.organizationId),
          eq(messages.conversationId, conversationId),
          inArray(linkPreviews.messageId, [...messageIds]),
          isNull(messages.deletedAt),
        ),
      );
  }
}
