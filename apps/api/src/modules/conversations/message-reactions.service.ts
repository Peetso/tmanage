import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageReactionsRepository } from './message-reactions.repository.js';

/**
 * x246 message reactions — CH-07 "Message actions"'s application service.
 *
 * `ConversationsService`'s two-gate rule, restated for reactions because the same rule governs
 * every read and write against a channel: `authorize()` runs first and is authoritative
 * (`conversation.write` to add or remove, `conversation.read` for the tally), and a
 * **narrowing** conversation-membership check follows — the acting principal must be a member
 * of the conversation, or hold organization-wide scope. The membership check can only take
 * access away; a gate that could add access would be a second authorization system, which
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION` §4 forbids policy from being.
 *
 * The conversation is resolved by `(tenant, id)` and the message by its id **within that
 * conversation** BEFORE either gate decides anything it could leak: a conversation in another
 * studio is not found (the read is org-scoped), and a message that belongs to a different
 * channel — cross-tenant or not — is a 404 with no reaction written. 404 rather than 403 for a
 * channel the principal cannot reach, for the reason `ConversationsService` gives: a channel's
 * existence is itself information.
 *
 * A reaction is the acting **membership's**, self-scoped: the add and the remove name
 * `context.membershipId`, so a member only ever touches their own row, and the tally's
 * "reacted" flag is that membership's own reactions.
 */

/** What a caller is allowed to see of a message's reactions. */
export interface MessageReactionTallyView {
  readonly messageId: string;
  readonly reactions: readonly {
    readonly emoji: string;
    readonly count: number;
    /** Whether the acting membership itself reacted with this emoji. */
    readonly reacted: boolean;
  }[];
}

/**
 * The fixed reaction allowlist — CH-07's "reactions". An emoji outside this set is a 400 rather
 * than a stored row: the set is deliberately small and closed so the column holds only known
 * glyphs, and widening it is a code change (a new entry here) rather than a migration.
 */
export const ALLOWED_REACTIONS: readonly string[] = Object.freeze([
  '\u{1F44D}', // 👍 thumbs up
  '\u{1F44E}', // 👎 thumbs down
  '❤️', // ❤️ red heart
  '\u{1F389}', // 🎉 party popper
  '\u{1F604}', // 😄 grinning face
  '\u{1F615}', // 😕 confused face
  '\u{1F680}', // 🚀 rocket
  '\u{1F440}', // 👀 eyes
]);

export function isAllowedReaction(emoji: string): boolean {
  return ALLOWED_REACTIONS.includes(emoji);
}

export class MessageReactionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly reactions: MessageReactionsRepository = new MessageReactionsRepository(),
  ) {}

  /**
   * Add the acting membership's reaction, then return the message's tally. Idempotent: a second
   * add of the same emoji is a no-op at the store and answers the same tally.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageReactionTallyView> {
    this.requireAllowed(emoji);
    await this.resolveWritableMessage(context, principal, conversationId, messageId);

    await this.database.transaction(context, (tx) =>
      this.reactions.add(tx, context, messageId, context.membershipId, emoji),
    );

    return this.buildTally(context, messageId);
  }

  /**
   * Remove the acting membership's reaction. Idempotent: removing one that is not there succeeds.
   * The store scopes the delete to `context.membershipId`, so this can only clear the caller's own.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    this.requireAllowed(emoji);
    await this.resolveWritableMessage(context, principal, conversationId, messageId);

    await this.database.transaction(context, (tx) =>
      this.reactions.remove(tx, context, messageId, context.membershipId, emoji),
    );
  }

  /** The tally for a message the acting principal can read. */
  async tally(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<MessageReactionTallyView> {
    await this.resolveMessage(context, principal, conversationId, messageId, 'conversation.read');
    return this.buildTally(context, messageId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private requireAllowed(emoji: string): void {
    if (!isAllowedReaction(emoji)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'emoji', message: 'must be one of the allowed reactions' },
      ]);
    }
  }

  /**
   * Resolve a message the principal may write a reaction to, or 404 — with a 409 for a message
   * that has been moderated, whose body is withheld and which nobody should be decorating.
   */
  private async resolveWritableMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
  ): Promise<MessageRow> {
    const message = await this.resolveMessage(
      context,
      principal,
      conversationId,
      messageId,
      'conversation.write',
    );
    if (message.deletedAt !== null) {
      throw new ApiError(409, 'conflict', 'This message was taken down and cannot be reacted to');
    }
    return message;
  }

  /**
   * The conversation by `(tenant, id)` and the gate, then the message within that conversation.
   * Any miss — unknown or cross-tenant conversation, unreachable channel, or a message that is
   * not in it — is a 404 before any reaction is read or written.
   */
  private async resolveMessage(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageId: string,
    capability: Extract<Capability, 'conversation.read' | 'conversation.write'>,
  ): Promise<MessageRow> {
    const conversation = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!conversation || !(await this.mayReach(context, principal, conversation, capability))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const message = await this.database.read(context, (runner) =>
      this.conversations.findMessageById(runner, context, messageId),
    );
    if (!message || message.conversationId !== conversationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return message;
  }

  /**
   * The evaluator, then conversation membership — `ConversationsService.mayReach`'s rule.
   * `authorize()` is authoritative; organization-wide scope skips the membership row (an Owner's
   * access derives from scope, not from a row); otherwise a conversation-membership row is
   * required. The check can only ever narrow.
   */
  private async mayReach(
    context: TenantContext,
    principal: Principal,
    row: ConversationRow,
    capability: Extract<Capability, 'conversation.read' | 'conversation.write'>,
  ): Promise<boolean> {
    const verdict = authorize({
      principal,
      capability,
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

  private async buildTally(
    context: TenantContext,
    messageId: string,
  ): Promise<MessageReactionTallyView> {
    const [counts, mine] = await Promise.all([
      this.database.read(context, (runner) => this.reactions.tally(runner, context, messageId)),
      this.database.read(context, (runner) =>
        this.reactions.mine(runner, context, messageId, context.membershipId),
      ),
    ]);
    const reacted = new Set(mine);
    return {
      messageId,
      reactions: counts.map((row) => ({
        emoji: row.emoji,
        count: row.count,
        reacted: reacted.has(row.emoji),
      })),
    };
  }
}
