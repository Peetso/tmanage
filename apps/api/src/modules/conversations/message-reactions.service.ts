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
 * The fixed reaction allowlist — CH-07's "reactions", widened in R7 to a curated ~60. An emoji outside this set is a 400 rather
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
  // A16 (chat basics): the quick reactions the approved Figma draws — ♥ ✓ ☺ ★.
  '\u{2713}', // ✓ check mark
  '\u{263A}', // ☺ smiling face
  '\u{2605}', // ★ black star
  // R7 slice 4: the curated set the emoji picker offers for reactions (one code point each,
  // no variation selectors).
  '\u{1F602}',
  '\u{1F60D}',
  '\u{1F622}',
  '\u{1F62E}',
  '\u{1F621}',
  '\u{1F64F}',
  '\u{1F44F}',
  '\u{1F525}',
  '\u{1F4AF}',
  '\u{2705}',
  '\u{274C}',
  '\u{1F914}',
  '\u{1F60A}',
  '\u{1F60E}',
  '\u{1F973}',
  '\u{1F929}',
  '\u{1F605}',
  '\u{1F923}',
  '\u{1F610}',
  '\u{1F634}',
  '\u{1F62C}',
  '\u{1F917}',
  '\u{1F64C}',
  '\u{1F4AA}',
  '\u{1F91D}',
  '\u{1F44C}',
  '\u{270C}',
  '\u{1F44B}',
  '\u{1F449}',
  '\u{261D}',
  '\u{2B50}',
  '\u{2728}',
  '\u{1F4A1}',
  '\u{1F4CC}',
  '\u{1F4CE}',
  '\u{23F0}',
  '\u{1F4C5}',
  '\u{1F381}',
  '\u{1F3C6}',
  '\u{1F947}',
  '\u{1F48E}',
  '\u{1F4B0}',
  '\u{1F4C8}',
  '\u{1F6A9}',
  '\u{26A0}',
  '\u{2757}',
  '\u{2753}',
  '\u{1F4AC}',
  '\u{1F49C}',
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

  /**
   * C5 — the tallies of several messages of one conversation in one round trip, so a channel
   * reads its reaction pills with one request instead of one per message. The conversation gate
   * runs once (`conversation.read`); ids that are not messages of this conversation are dropped
   * rather than answered, so the batch never says anything about another channel's message.
   * Answers in the order asked, a message without reactions with an empty list.
   */
  async tallyMany(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<readonly MessageReactionTallyView[]> {
    const conversation = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (
      !conversation ||
      !(await this.mayReach(context, principal, conversation, 'conversation.read'))
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const asked = [...new Set(messageIds)];
    const { inConversation, counts, mine } = await this.database.read(context, async (runner) => {
      const ids = await this.reactions.messageIdsInConversation(
        runner,
        context,
        conversationId,
        asked,
      );
      return {
        inConversation: new Set(ids),
        counts: await this.reactions.tallyMany(runner, context, ids),
        mine: await this.reactions.mineMany(runner, context, ids, context.membershipId),
      };
    });
    const reacted = new Set(mine.map((row) => `${row.messageId}|${row.emoji}`));
    return asked
      .filter((messageId) => inConversation.has(messageId))
      .map((messageId) => ({
        messageId,
        reactions: counts
          .filter((row) => row.messageId === messageId)
          .map((row) => ({
            emoji: row.emoji,
            count: row.count,
            reacted: reacted.has(`${messageId}|${row.emoji}`),
          })),
      }));
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
