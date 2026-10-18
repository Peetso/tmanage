import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Audience, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CONVERSATIONS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ConversationMemberView,
  ConversationView,
  ConversationsService,
  ConvertMessageResultView,
  MessageContentCommand,
  MessageRevisionView,
  MessageView,
} from './conversations.service.js';
import type { ChannelDirectoryEntry } from './channel-directory.js';

/**
 * CHAT-001's HTTP surface.
 *
 * `WorkItemsController`'s shape and the same rule about what it does not do: it reads no
 * `organizationId` from anywhere, because `TenantContextGuard` built the `TenantContext` from
 * a membership row and there is no field on any body below for a caller to supply one.
 *
 * Four things are specific to this aggregate.
 *
 * 1. **`sequenceNo` is not a field.** `23-ERD` §4 makes the sequence the conversation's own
 *    order, allocated under its row lock. A body that could set it would be a way to insert a
 *    message into the middle of a transcript.
 * 2. **The version is required to rename or archive, and is not required to post.** A message
 *    is an append; there is nothing about the channel for a concurrent writer to lose.
 * 3. **`13-ENGINEERING` §3 writes the message route as `POST /v1/conversations/{id}/messages`
 *    and this controller mounts it under the organization slug**, as every other route in this
 *    application is. The divergence is the pack's own shorthand rather than a decision: an
 *    unprefixed path would have no slug for `TenantContextGuard` to resolve, and every route
 *    that exists today would have to move for the sake of one that does not.
 * 4. **A deduplicated post answers 200, not 201.** `23-ERD` §4 asks for retry dedupe on a
 *    client-generated id; a retry that returns 201 tells the caller a second message was
 *    created, which is the thing dedupe exists to prevent.
 */

interface CreateConversationBody {
  readonly projectId?: unknown;
  readonly name?: unknown;
}

interface RenameConversationBody {
  readonly version?: unknown;
  readonly name?: unknown;
}

interface ArchiveConversationBody {
  readonly version?: unknown;
}

interface AddMemberBody {
  readonly userId?: unknown;
}

interface PostMessageBody {
  readonly body?: unknown;
  readonly bodyRich?: unknown;
  readonly parentMessageId?: unknown;
  readonly clientGeneratedId?: unknown;
}

interface EditMessageBody {
  readonly body?: unknown;
  readonly bodyRich?: unknown;
}

interface ConvertMessageBody {
  readonly title?: unknown;
  readonly type?: unknown;
  readonly ownerUserId?: unknown;
  readonly audience?: unknown;
  readonly startAt?: unknown;
  readonly dueAt?: unknown;
}

/**
 * Only `status`, for the reason `SessionController`'s `ReplyLike` gives: taking Fastify's full
 * reply and calling `send()` on it would switch Nest into library-specific mode, where the
 * interceptors and the exception filter no longer shape the response. `@Res({ passthrough:
 * true })` keeps the return value as the body and lets one route choose between 200 and 201.
 */
interface ReplyLike {
  status(code: number): unknown;
}

/** `conversations.name` is `VARCHAR(120)`. */
const MAX_NAME_LENGTH = 120;
/** `work_items.title` is `VARCHAR(300)`, and `type` capped at 32 — `WorkItemsController`'s numbers. */
const MAX_WORK_TITLE_LENGTH = 300;
const MAX_WORK_TYPE_LENGTH = 32;
const WORK_AUDIENCES: readonly Audience[] = [
  'internal',
  'client_visible',
  'client_action_required',
];
/**
 * `messages.body` is `TEXT`, which holds 65535 **bytes**. The limit here is in characters and
 * is set well under it: a `TEXT` column silently truncating a multi-byte message under
 * `STRICT_ALL_TABLES` would be an error rather than a truncation, but an error at the driver
 * is a 500, and a message that is too long deserves a 400 that says so.
 */
const MAX_BODY_LENGTH = 16_000;

@Controller('v1/organizations/:orgSlug')
export class ConversationsController {
  constructor(
    @Inject(CONVERSATIONS_SERVICE) private readonly conversations: ConversationsService,
  ) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  @Get('conversations')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<{ readonly conversations: readonly ConversationView[] }> {
    const details: { field: string; message: string }[] = [];
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      conversations: await this.conversations.list(context, principal, {
        ...(projectId ? { projectId } : {}),
        ...(after ? { after } : {}),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(includeArchived === 'true' ? { includeArchived: true } : {}),
      }),
    };
  }

  /**
   * CH-01's channel browser: reachable channels (archived included) with members, client members
   * and last activity, newest activity first. A static path, so it wins over `:conversationId`.
   */
  @Get('conversations/directory')
  @RequireCapability('conversation.read')
  async directory(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly channels: readonly ChannelDirectoryEntry[] }> {
    return { channels: await this.conversations.directory(context, principal) };
  }

  @Get('conversations/:conversationId')
  @RequireCapability('conversation.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationView> {
    return this.conversations.get(context, principal, conversationId);
  }

  @Post('conversations')
  @RequireCapability('conversation.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateConversationBody,
  ): Promise<ConversationView> {
    const details: { field: string; message: string }[] = [];

    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    if (!projectId) details.push({ field: 'projectId', message: 'must be a string' });
    const name = channelName(body?.name, details);

    if (details.length > 0 || !projectId || name === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.conversations.create(context, principal, { projectId, name });
  }

  @Patch('conversations/:conversationId')
  @RequireCapability('conversation.write')
  async rename(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: RenameConversationBody,
  ): Promise<ConversationView> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);
    const name = channelName(body?.name, details);

    if (details.length > 0 || version === undefined || name === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.conversations.rename(context, principal, conversationId, version, name);
  }

  /**
   * Archive a channel. `POST` to a sub-resource rather than a `DELETE`, because it is not a
   * deletion: the channel and everything said in it stay, and the name stays taken.
   */
  @Post('conversations/:conversationId/archival')
  @RequireCapability('conversation.write')
  // 200 rather than Nest's default 201 for a POST: nothing was created.
  @HttpCode(200)
  async archive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: ArchiveConversationBody,
  ): Promise<ConversationView> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);
    if (details.length > 0 || version === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.conversations.archive(context, principal, conversationId, version);
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  @Get('conversations/:conversationId/members')
  @RequireCapability('conversation.read')
  async listMembers(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ readonly members: readonly ConversationMemberView[] }> {
    return { members: await this.conversations.listMembers(context, principal, conversationId) };
  }

  @Post('conversations/:conversationId/members')
  @RequireCapability('conversation.write')
  @HttpCode(201)
  async addMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: AddMemberBody,
  ): Promise<ConversationMemberView> {
    const userId = typeof body?.userId === 'string' && body.userId !== '' ? body.userId : undefined;
    if (!userId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'userId', message: 'must be a non-empty string' },
      ]);
    }
    return this.conversations.addMember(context, principal, conversationId, userId);
  }

  @Delete('conversations/:conversationId/members/:userId')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async removeMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.conversations.removeMember(context, principal, conversationId, userId);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /**
   * Read a channel, or one thread inside it.
   *
   * `parentMessageId` absent means the channel view — top-level messages only. Supplying a
   * message id means that message's replies, which is TM-08's thread pane. There is no way to
   * ask for both, because a screen that mixed replies into the channel would be drawing a
   * conversation nobody had.
   */
  @Get('conversations/:conversationId/messages')
  @RequireCapability('conversation.read')
  async listMessages(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('parentMessageId') parentMessageId?: string,
    @Query('afterSequenceNo') afterSequenceNo?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly messages: readonly MessageView[] }> {
    const details: { field: string; message: string }[] = [];

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    const parsedAfter = afterSequenceNo === undefined ? undefined : Number(afterSequenceNo);
    if (parsedAfter !== undefined && (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0)) {
      details.push({ field: 'afterSequenceNo', message: 'must be a non-negative integer' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      messages: await this.conversations.listMessages(context, principal, conversationId, {
        // `null` is "top level only", which is the default; a supplied id is a thread.
        parentMessageId: parentMessageId === undefined ? null : parentMessageId,
        ...(parsedAfter === undefined ? {} : { afterSequenceNo: parsedAfter }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }

  /**
   * Convert a message into a work item — TM-06's "create work", FR-02's confirmed fields.
   *
   * 201 when the conversion happened here; **200 when this message was already converted**,
   * with the existing conversion as the body — INT-07's "one linked work item on retry",
   * answered the way the deduplicated post below answers.
   */
  @Post('conversations/:conversationId/messages/:messageId/work-items')
  @RequireCapability('work.create')
  async convertMessage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: ConvertMessageBody,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<ConvertMessageResultView> {
    const details: { field: string; message: string }[] = [];

    const title = optionalTrimmed(body?.title, 'title', MAX_WORK_TITLE_LENGTH, details);
    const type = optionalTrimmed(body?.type, 'type', MAX_WORK_TYPE_LENGTH, details);
    const audience = optionalWorkAudience(body?.audience, details);
    const startAt = optionalInstant(body?.startAt, 'startAt', details);
    const dueAt = optionalInstant(body?.dueAt, 'dueAt', details);
    const ownerUserId =
      typeof body?.ownerUserId === 'string' && body.ownerUserId !== ''
        ? body.ownerUserId
        : undefined;

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const result = await this.conversations.convertMessageToWork(
      context,
      principal,
      conversationId,
      messageId,
      {
        ...(title === undefined ? {} : { title }),
        ...(type === undefined ? {} : { type }),
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
        ...(audience === undefined ? {} : { audience }),
        ...(startAt === undefined ? {} : { startAt }),
        ...(dueAt === undefined ? {} : { dueAt }),
      },
    );

    reply.status(result.created ? 201 : 200);
    return result;
  }

  /**
   * Post a message. 201 for a new one, **200 for a deduplicated retry** — see the note at the
   * top of this file. The status is set on the reply rather than by a decorator because it
   * depends on what happened.
   */
  @Post('conversations/:conversationId/messages')
  @RequireCapability('conversation.write')
  async postMessage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: PostMessageBody,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<MessageView> {
    const details: { field: string; message: string }[] = [];
    const content = messageContent(body, details);

    const parentMessageId =
      typeof body?.parentMessageId === 'string' && body.parentMessageId !== ''
        ? body.parentMessageId
        : undefined;
    const clientGeneratedId =
      typeof body?.clientGeneratedId === 'string' && body.clientGeneratedId !== ''
        ? body.clientGeneratedId
        : undefined;

    if (details.length > 0 || content === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const result = await this.conversations.postMessage(context, principal, conversationId, {
      ...content,
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      ...(clientGeneratedId === undefined ? {} : { clientGeneratedId }),
    });

    reply.status(result.created ? 201 : 200);
    return result.message;
  }

  @Patch('conversations/:conversationId/messages/:messageId')
  @RequireCapability('conversation.write')
  async editMessage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: EditMessageBody,
  ): Promise<MessageView> {
    const details: { field: string; message: string }[] = [];
    const content = messageContent(body, details);
    if (details.length > 0 || content === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.conversations.editMessage(context, principal, conversationId, messageId, content);
  }

  /**
   * A message's edit history — TM-06 lists "edit history" among the message actions. Oldest
   * first; the current body is the message itself. The rows are engine-written
   * (`0008_message_rich_text.sql`), so this is a read of what happened rather than of what
   * the application remembered to record.
   */
  @Get('conversations/:conversationId/messages/:messageId/revisions')
  @RequireCapability('conversation.read')
  async listRevisions(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<{ readonly revisions: readonly MessageRevisionView[] }> {
    return {
      revisions: await this.conversations.listRevisions(
        context,
        principal,
        conversationId,
        messageId,
      ),
    };
  }

  /**
   * Take a message down.
   *
   * `DELETE`, and the row survives it — `12-PERMISSION-MATRIX` §2's "Moderate messages". The
   * response is the message with its body gone and its removal recorded, rather than 204,
   * because the caller's screen has to show that something was removed rather than that
   * nothing was ever there.
   */
  @Delete('conversations/:conversationId/messages/:messageId')
  @RequireCapability('conversation.read')
  async moderateMessage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageView> {
    return this.conversations.moderateMessage(context, principal, conversationId, messageId);
  }
}

/**
 * A channel name, trimmed and checked.
 *
 * The leading `#` from `19-SEED-DATA-AND-COPY`'s `#atlas-relaunch` is presentation: it is
 * stripped here so that `#general` and `general` are the same channel rather than two, which
 * the unique key would otherwise happily allow.
 */
function channelName(
  value: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim().replace(/^#+/, '').trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'must be a non-empty string' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
    return undefined;
  }
  return trimmed;
}

/**
 * A message body.
 *
 * Trimmed, and an empty message is refused: a channel full of blank lines is not a feature and
 * the alternative is every reader deciding for itself whether to draw one.
 */
function messageBody(
  value: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'body', message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'body', message: 'must be a non-empty string' });
    return undefined;
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    details.push({ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` });
    return undefined;
  }
  return trimmed;
}

/**
 * What a message says — exactly one of `body` (plain text) and `bodyRich` (a rich-text
 * document).
 *
 * The plain form gets the full shape check here, as CHAT-001 wrote it. The rich form is only
 * checked to be a JSON object — whether the *document* is admissible is the sanitiser's
 * decision, made in the service where the write boundary lives, and its refusal carries the
 * path to the offending node. Sending both is refused rather than ranked: a request that says
 * the same thing twice is a request whose two versions can disagree.
 */
function messageContent(
  value: { readonly body?: unknown; readonly bodyRich?: unknown } | undefined,
  details: { field: string; message: string }[],
): MessageContentCommand | undefined {
  const hasPlain = value?.body !== undefined;
  const hasRich = value?.bodyRich !== undefined;

  if (hasPlain && hasRich) {
    details.push({ field: 'body', message: 'provide either body or bodyRich, not both' });
    return undefined;
  }
  if (!hasPlain && !hasRich) {
    details.push({ field: 'body', message: 'either body or bodyRich is required' });
    return undefined;
  }

  if (hasPlain) {
    const text = messageBody(value?.body, details);
    return text === undefined ? undefined : { body: text };
  }

  const rich = value?.bodyRich;
  if (typeof rich !== 'object' || rich === null || Array.isArray(rich)) {
    details.push({ field: 'bodyRich', message: 'must be a rich-text document object' });
    return undefined;
  }
  return { bodyRich: rich };
}

/**
 * `WorkItemsController`'s `optionalShortString` and `optionalAudience`, restated here for the
 * conversion body. Restated rather than imported: the two controllers do not otherwise know
 * each other, and a helpers module shared for three small functions would be a boundary
 * crossed for less than it costs.
 */
function optionalTrimmed(
  raw: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: 'must be a non-empty string' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    details.push({ field, message: `must be ${max} characters or fewer` });
    return undefined;
  }
  return value;
}

function optionalWorkAudience(
  raw: unknown,
  details: { field: string; message: string }[],
): Audience | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(WORK_AUDIENCES as readonly string[]).includes(raw)) {
    details.push({ field: 'audience', message: `must be one of ${WORK_AUDIENCES.join(', ')}` });
    return undefined;
  }
  return raw as Audience;
}

/** An ISO 8601 instant or null-to-clear, exactly as `WorkItemsController` reads one. */
function optionalInstant(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    details.push({ field, message: 'must be an ISO 8601 instant, such as 2026-09-30T17:00:00Z' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: 'is not a real instant' });
    return undefined;
  }
  return parsed;
}

/**
 * The concurrency token, required rather than optional.
 *
 * Accepts a number or a numeric string, because `version` is `BIGINT UNSIGNED` and a client
 * that round-trips it through JSON may have it either way — the same reasoning
 * `WorkItemsController` records.
 */
function requiredVersion(
  value: unknown,
  details: { field: string; message: string }[],
): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    details.push({ field: 'version', message: 'must be the version you read' });
    return undefined;
  }
  return parsed;
}
