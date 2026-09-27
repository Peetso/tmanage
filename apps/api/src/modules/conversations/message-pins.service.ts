import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationPinnedMessageRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessagePinsRepository } from './message-pins.repository.js';

/**
 * x247 — pinning a message to a conversation's pinned-context list (CH-07 "Message actions" / CH-02
 * "pinned context").
 *
 * ## Two capabilities, and the order that makes them safe
 *
 * Curating what a channel keeps at the top is a moderation act — `12-PERMISSION-MATRIX` §2 — so a
 * pin and an unpin are behind `conversation.moderate`, the capability a Manager or Moderator holds
 * over a project. Reading the pinned strip is an ordinary channel read, behind `conversation.read`.
 *
 * Every write **resolves the conversation, then the message within it, BEFORE it authorizes**, and
 * a missing or cross-tenant conversation, or a message that is not this conversation's, is a 404
 * with no row written. That order is the same one `ConversationsService.moderateMessage` keeps and
 * it matters here for the same reason: `findById`/`findMessageById` are tenant-scoped, so the
 * resolve is itself the tenant boundary, and only once the target is known to exist in this tenant
 * does the capability decide the outcome. A caller who resolves a real message but lacks
 * `conversation.moderate` gets 403 and nothing is inserted — the refusal `message-pins.controller.
 * test.ts` proves.
 *
 * ## Why the pin cap is a 409
 *
 * A pinned strip that could grow without bound stops being a strip. The cap ({@link MAX_PINS}) is
 * checked inside the write transaction against the live count, so two concurrent pins cannot both
 * pass a stale check — the unique key already makes a duplicate idempotent, and the cap makes an
 * over-full channel a 409 rather than a silent 26th pin.
 */

/** The most messages a single conversation may keep pinned. A 26th pin is a 409. */
export const MAX_PINS = 25;

/** What a caller is allowed to see of a pinned message — a reference, never a copy of the body. */
export interface PinnedMessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly pinnedByUserId: string;
  readonly pinnedAt: string;
}

function toPinnedMessageView(row: ConversationPinnedMessageRow): PinnedMessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    pinnedByUserId: row.pinnedByUserId,
    pinnedAt: row.pinnedAt.toISOString(),
  };
}

export class MessagePinsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly pins: MessagePinsRepository,
    private readonly conversations: ConversationsRepository,
  ) {}

  /**
   * A conversation's pinned messages, oldest first — behind `conversation.read`.
   *
   * The conversation is resolved tenant-scoped and the acting principal must be able to read it
   * (the capability, plus channel membership unless they hold organization-wide scope), exactly as
   * every other read of this channel is gated. A conversation the principal cannot read is 404:
   * a channel's existence is itself information.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<readonly PinnedMessageView[]> {
    await this.loadReadable(context, principal, conversationId);
    const rows = await this.database.read(context, (runner) =>
      this.pins.list(runner, context, conversationId),
    );
    return rows.map(toPinnedMessageView);
  }

  /**
   * Pin a message — behind `conversation.moderate`. Idempotent: pinning an already-pinned message
   * returns the existing pin. Resolves the conversation, then the message within it, before it
   * authorizes; refuses an over-full channel with 409.
   */
  async pin(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<PinnedMessageView> {
    await this.resolveForModeration(context, principal, conversationId, messageId);

    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.pins.findPin(tx, context, conversationId, messageId);
      if (existing) return existing;

      const pinned = await this.pins.count(tx, context, conversationId);
      if (pinned >= MAX_PINS) {
        throw new ApiError(
          409,
          'conflict',
          `A conversation may keep at most ${MAX_PINS} messages pinned`,
        );
      }

      return this.pins.pin(tx, context, {
        conversationId,
        messageId,
        pinnedByUserId: context.userId,
      });
    });

    return toPinnedMessageView(row);
  }

  /**
   * Unpin a message — behind `conversation.moderate`. Idempotent: unpinning a message that is not
   * pinned is a no-op, and the controller answers 204 either way.
   */
  async unpin(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.resolveForModeration(context, principal, conversationId, messageId);
    await this.database.transaction(context, (tx) =>
      this.pins.unpin(tx, context, conversationId, messageId),
    );
  }

  /**
   * Resolve the conversation and the message within it, tenant-scoped, then require
   * `conversation.moderate`. Returns the conversation's project id for the authorized caller.
   *
   * Resolve-before-authorize: a missing conversation, or a message that is not this conversation's,
   * is 404 (no capability leak about whether the row exists elsewhere); a resolved target the
   * principal may not moderate is 403, and no write follows.
   */
  private async resolveForModeration(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const conversation = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!conversation) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const message = await this.database.read(context, (runner) =>
      this.conversations.findMessageById(runner, context, messageId),
    );
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'conversation.moderate',
      resource: {
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  /**
   * Load a conversation this principal may read, or 404 — `authorize('conversation.read')` plus
   * channel membership, the narrowing gate every read of this aggregate applies. Organization-wide
   * scope skips the membership row, the way `ConversationsService` does.
   */
  private async loadReadable(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!conversation) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'conversation.read',
      resource: {
        organizationId: conversation.organizationId,
        projectId: conversation.projectId,
        audience: 'internal',
        lifecycle: conversation.archivedAt === null ? 'active' : 'archived',
      },
    });

    let reachable = verdict.allowed;
    if (reachable && !principal.hasOrgWideScope) {
      const membership = await this.database.read(context, (runner) =>
        this.conversations.findMembership(runner, context, conversation.id, principal.userId),
      );
      reachable = membership !== null;
    }
    if (!reachable) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
  }
}
