import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow } from '../../common/database/schema.js';
import { type ConversationsRepository } from './conversations.repository.js';
import { type ConversationMuteRepository } from './conversation-mute.repository.js';

/**
 * CH-09's application service — a member's own mute/unmute state for one conversation (x252).
 *
 * ## Resolve the conversation, then read the flag; the mute is nobody else's
 *
 * The subject is the acting `principal`'s membership, so no caller can read or write another
 * member's mute state — the route has no field for one. The conversation is resolved **within the
 * tenant and authorized before anything is read or written**: a conversation in another studio (or
 * one this caller may not reach) is a 404 and no row is ever touched, the same 404 the conversations
 * surface gives and for the same reason — the existence of a channel is not disclosed to someone who
 * cannot see it.
 *
 * ## Two gates, and the narrower one is not the evaluator's
 *
 * {@link requireReachable} mirrors `ConversationsService.mayReach` for `conversation.read`:
 * `authorize()` is authoritative and runs first, then conversation membership narrows it. Org-wide
 * scope skips the membership check for the reason the evaluator skips the project-relation check for
 * it — an Owner's access derives from scope, not from a row. The HTTP capability guard has already
 * refused a caller who does not hold `conversation.read` at all; this is the resource-scoped check the
 * guard cannot make.
 *
 * ## Read-only preference this slice
 *
 * Nothing dispatches off the mute state yet — this is the durable preference a later notification
 * change will honour. Absence of a row is "not muted", so "never set" and "set to false" are one
 * behaviour, not two.
 */
export class ConversationMuteService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly mutes: ConversationMuteRepository,
    private readonly conversations: ConversationsRepository,
  ) {}

  /** This member's mute state for the conversation, or `false` when they have never set it. */
  async getMute(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<boolean> {
    await this.requireReachable(context, principal, conversationId);
    const row = await this.database.read(context, (runner) =>
      this.mutes.findMute(runner, context, conversationId, principal.membershipId),
    );
    return row?.muted ?? false;
  }

  /** Set this member's mute state for the conversation and read it back. */
  async setMute(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    muted: boolean,
  ): Promise<boolean> {
    // Resolve and authorize BEFORE any write: another tenant's conversation is a 404 and no upsert.
    await this.requireReachable(context, principal, conversationId);
    return this.database.transaction(context, async (tx) => {
      await this.mutes.upsert(tx, context, conversationId, principal.membershipId, muted);
      const row = await this.mutes.findMute(tx, context, conversationId, principal.membershipId);
      return row?.muted ?? muted;
    });
  }

  /** Load a conversation this principal may read, or 404 — identical policy to the read path. */
  private async requireReachable(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<ConversationRow> {
    const row = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!row || !(await this.mayRead(context, principal, row))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /** The evaluator, then conversation membership. Both must pass; org-wide scope skips the second. */
  private async mayRead(
    context: TenantContext,
    principal: Principal,
    row: ConversationRow,
  ): Promise<boolean> {
    const verdict = authorize({
      principal,
      capability: 'conversation.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'internal',
        lifecycle: row.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) return false;

    if (principal.hasOrgWideScope) return true;

    const membership = await this.database.read(context, (runner) =>
      this.conversations.findMembership(runner, context, row.id, principal.userId),
    );
    return membership !== null;
  }
}
