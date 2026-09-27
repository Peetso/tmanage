import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { type MessageDraftsRepository } from './message-drafts.repository.js';

/**
 * x251's application service — save / read / clear a member's unsent composer draft.
 *
 * ## The gate is the conversation's, applied before the draft is touched
 *
 * A draft hangs off a conversation, so reaching one is exactly reaching the conversation to
 * write in it: `ConversationsService.mayReach` for `conversation.write`, restated here rather
 * than exported, because that service does not open its internals (its module note records
 * why). The order is the rule `25-AUTH-AND-TENANT-ISOLATION` §4 fixes and CHAT-001 documents at
 * length: **resolve the conversation in the tenant first, then `authorize()`, then narrow by
 * conversation membership.** A conversation the caller has no relation to is 404, never 403 —
 * a channel's existence is itself information. Every refusal on this path is a 404 for that
 * reason, and none of it writes.
 *
 * ## The draft is the acting membership's, always
 *
 * There is no path or body that names a membership: the row is keyed to `context.membershipId`,
 * so a caller reads, writes and clears their own draft and no other, even among the members of a
 * conversation they can all write to. `hasOrgWideScope` skips the conversation-membership check
 * exactly as it does for a message — an Owner's access derives from scope, not from a row — but
 * the draft is still theirs alone, because it is still keyed to their own membership.
 */

/** What a caller sees of a draft. `body` is null when none has been saved. */
export interface MessageDraftView {
  readonly body: string | null;
  readonly updatedAt: string | null;
}

/** The stored draft payload, `{ body }`, exactly as the controller validated it. */
interface DraftBodyJson {
  readonly body: string;
}

export class MessageDraftsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly drafts: MessageDraftsRepository,
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
  ) {}

  /** The acting member's draft for a conversation they may write, or `{ body: null }`. */
  async get(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<MessageDraftView> {
    await this.requireWritableConversation(context, principal, conversationId);
    const row = await this.database.read(context, (runner) =>
      this.drafts.find(runner, context, conversationId, context.membershipId),
    );
    return toView(row?.bodyJson ?? null, row?.updatedAt ?? null);
  }

  /** Save (upsert) the acting member's draft. The body is validated by the controller. */
  async save(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    body: string,
  ): Promise<MessageDraftView> {
    await this.requireWritableConversation(context, principal, conversationId);
    const bodyJson: DraftBodyJson = { body };
    const row = await this.database.transaction(context, (tx) =>
      this.drafts.upsert(tx, context, {
        conversationId,
        membershipId: context.membershipId,
        bodyJson,
      }),
    );
    return toView(row.bodyJson, row.updatedAt);
  }

  /** Clear the acting member's draft. Idempotent — clearing a draft that is not there is a no-op. */
  async clear(context: TenantContext, principal: Principal, conversationId: string): Promise<void> {
    await this.requireWritableConversation(context, principal, conversationId);
    await this.database.transaction(context, (tx) =>
      this.drafts.remove(tx, context, conversationId, context.membershipId),
    );
  }

  /**
   * Resolve the conversation in the tenant, then `authorize('conversation.write')`, then narrow
   * by conversation membership. Any failure is a 404 with no write — the two-gate rule
   * `ConversationsService` applies, in the order it applies it.
   */
  private async requireWritableConversation(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<void> {
    const row = await this.database.read(context, (runner) =>
      this.conversations.findById(runner, context, conversationId),
    );
    if (!row || !(await this.mayWrite(context, principal, row))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
  }

  private async mayWrite(
    context: TenantContext,
    principal: Principal,
    row: ConversationRow,
  ): Promise<boolean> {
    const capability: Extract<Capability, 'conversation.write'> = 'conversation.write';
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
}

function toView(bodyJson: unknown, updatedAt: Date | null): MessageDraftView {
  const isDraft =
    bodyJson !== null &&
    typeof bodyJson === 'object' &&
    typeof (bodyJson as DraftBodyJson).body === 'string';
  return {
    body: isDraft ? (bodyJson as DraftBodyJson).body : null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}
