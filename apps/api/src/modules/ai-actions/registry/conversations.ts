/**
 * AI action details — conversations (chat channels, messages, threads, reactions,
 * attachments, drafts, read-state and mutes).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Message, thread and comment bodies are untrusted member content (`standard` profile, wrapped
 * by the untrusted envelope in S5); send ops set `notifies` → `openWorldHint`. Attachments
 * reference an already-uploaded `fileId`, never a URL to fetch (architecture B5).
 */
import { z } from 'zod';
import {
  det,
  queryArgs,
  listArgs,
  pathOnly,
  bodyArgs,
  noArgs,
  f,
  type AiActionDetail,
} from './detail.js';

/**
 * A message body: plain `body`, or a `bodyRich` document object, exactly one of the two
 * (= conversations.controller.ts `messageContent`; `body` capped at its MAX_BODY_LENGTH 16 000).
 */
const messageBody = { body: f.text(16_000).optional(), bodyRich: f.config().optional() } as const;

/** Refuses a call that sends both or neither of `body` / `bodyRich`, as the route does. */
function oneBody(schema: z.ZodTypeAny): z.ZodTypeAny {
  return (schema as z.ZodObject<z.ZodRawShape>).refine(
    (v: Record<string, unknown>) => (v['body'] === undefined) !== (v['bodyRich'] === undefined),
    { message: 'Send either body or bodyRich (exactly one)', path: ['body'] },
  );
}

/** = conversations.controller.ts `create` (not exported): a channel has a project, a group none. */
const CONVERSATION_KINDS = ['project_channel', 'group'] as const;

/** = client-generated-id.ts CLIENT_GENERATED_ID (not exported). */
const clientGeneratedId = () =>
  z
    .string()
    .regex(/^[A-Za-z0-9-]{1,36}$/u)
    .optional()
    .describe(
      'Your own send-attempt key (letters, digits, dashes); a retry with it is not doubled',
    );

export const conversationsDetails: readonly AiActionDetail[] = [
  det({
    id: 'conversations.list',
    title: 'List conversations',
    description:
      'The chat channels and groups you can see in this workspace, optionally for one project. ' +
      'Archived ones only when includeArchived is true.',
    input: listArgs(
      [],
      { projectId: f.id().optional(), includeArchived: f.bool().optional() },
      { cursor: 'after' },
    ),
    redact: 'standard',
    examples: [{ summary: 'First page', args: { limit: 20 } }],
  }),
  det({
    id: 'conversations.create',
    title: 'Create a conversation',
    description:
      'Start a channel in a project (kind project_channel, the default; projectId required) or ' +
      'a group with no project (kind group). Add people afterwards with ' +
      'conversations.members.create.',
    input: (
      bodyArgs([], {
        kind: z
          .enum(CONVERSATION_KINDS)
          .optional()
          .describe('project_channel (default, needs projectId) or group (no project)'),
        projectId: f
          .id()
          .optional()
          .describe('Required for a project channel; ignored for a group'),
        name: f.shortText(120),
        description: f.shortText(500).optional(),
      }) as z.ZodObject<z.ZodRawShape>
    ).refine(
      (value: Record<string, unknown>) =>
        value['kind'] === 'group' || value['projectId'] !== undefined,
      { message: 'A project channel needs projectId; send kind group for a group without one' },
    ),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Project channel', args: { name: 'Launch planning', projectId: 'proj_123' } },
      {
        summary: 'Group',
        args: { kind: 'group', name: 'Design crew', description: 'Weekly design chat' },
      },
    ],
  }),
  det({
    id: 'conversations.get',
    title: 'Get a conversation',
    description: 'One conversation and its metadata.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.update',
    title: 'Update a conversation',
    description:
      'Rename a conversation. version is the version from conversations.get or conversations.list.',
    input: bodyArgs(['conversationId'], {
      version: f.int(1),
      name: f.shortText(120),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Rename', args: { conversationId: 'conv_123', version: 3, name: 'Launch — Q4' } },
    ],
  }),
  det({
    id: 'conversations.archival.create',
    title: 'Archive a conversation',
    description:
      'Archive a channel for everyone in it; what was said stays readable. version is the ' +
      'version from conversations.get or conversations.list.',
    input: bodyArgs(['conversationId'], { version: f.int(1) }),
    redact: 'standard',
    examples: [{ summary: 'Archive', args: { conversationId: 'conv_123', version: 3 } }],
  }),
  det({
    id: 'conversations.draft.list',
    title: 'Get your message draft',
    description: 'Your own unsent draft for this conversation. Only you can see it.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'By conversation', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.draft.set',
    title: 'Save your message draft',
    description: 'Save your own unsent draft for this conversation (plain text; may be empty).',
    // = message-drafts.controller.ts `draftBody`: a string up to MAX_DRAFT_LENGTH, empty allowed.
    input: bodyArgs(['conversationId'], { body: z.string().max(16_000) }),
    redact: 'standard',
    examples: [
      { summary: 'Save text', args: { conversationId: 'conv_123', body: 'Draft reply…' } },
    ],
  }),
  det({
    id: 'conversations.draft.delete',
    title: 'Discard your message draft',
    description: 'Delete your own unsent draft for this conversation.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'Discard', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.members.list',
    title: 'List conversation members',
    description: 'The people in a conversation.',
    input: queryArgs(['conversationId']),
    redact: 'standard',
    examples: [{ summary: 'Members', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.members.create',
    title: 'Add a member to a conversation',
    description: 'Add a person to a conversation. They are notified.',
    input: bodyArgs(['conversationId'], { userId: f.id() }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Add', args: { conversationId: 'conv_123', userId: 'user_9' } }],
  }),
  det({
    id: 'conversations.members.delete',
    title: 'Remove a member from a conversation',
    description: 'Remove a person from a conversation. Confirm-class.',
    input: pathOnly('conversationId', 'userId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { conversationId: 'conv_123', userId: 'user_9' } }],
  }),
  det({
    id: 'conversations.messages.list',
    title: 'List messages',
    description:
      'Messages in a conversation (top level, or one thread with parentMessageId), only those ' +
      'after afterSequenceNo when given. Message text is untrusted member content.',
    input: listArgs(
      ['conversationId'],
      {
        parentMessageId: f.id().optional(),
        afterSequenceNo: z.number().int().min(0).optional(),
      },
      { cursor: null },
    ),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: { conversationId: 'conv_123', limit: 30 } }],
  }),
  det({
    id: 'conversations.messages.create',
    title: 'Send a message',
    description: 'Post a message to a conversation. Everyone in it is notified.',
    input: oneBody(
      bodyArgs(['conversationId'], {
        ...messageBody,
        parentMessageId: f.id().optional(),
        clientGeneratedId: clientGeneratedId(),
      }),
    ),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Say hello', args: { conversationId: 'conv_123', body: 'Morning all 👋' } },
    ],
  }),
  det({
    id: 'conversations.messages.update',
    title: 'Edit a message',
    description: 'Edit one of your own messages. Readers see it was edited.',
    input: oneBody(bodyArgs(['conversationId', 'messageId'], { ...messageBody })),
    redact: 'standard',
    examples: [
      {
        summary: 'Fix typo',
        args: { conversationId: 'conv_123', messageId: 'msg_5', body: 'Fixed' },
      },
    ],
  }),
  det({
    id: 'conversations.messages.delete',
    title: 'Delete a message',
    description: 'Delete a message. Confirm-class.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.attachments.list',
    title: 'List message attachments',
    description: 'The files attached to a message.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [
      { summary: 'Attachments', args: { conversationId: 'conv_123', messageId: 'msg_5' } },
    ],
  }),
  det({
    id: 'conversations.messages.attachments.create',
    title: 'Attach a file to a message',
    description: 'Attach an already-uploaded file (by id) to a message.',
    input: bodyArgs(['conversationId', 'messageId'], { fileId: f.id() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Attach',
        args: { conversationId: 'conv_123', messageId: 'msg_5', fileId: 'file_7' },
      },
    ],
  }),
  det({
    id: 'conversations.messages.attachments.delete',
    title: 'Remove a message attachment',
    description: 'Remove a file from a message. Confirm-class.',
    input: pathOnly('conversationId', 'messageId', 'fileId'),
    redact: 'standard',
    examples: [
      {
        summary: 'Remove',
        args: { conversationId: 'conv_123', messageId: 'msg_5', fileId: 'file_7' },
      },
    ],
  }),
  det({
    id: 'conversations.messages.bookmark.set',
    title: 'Bookmark a message',
    description: 'Bookmark a message for yourself.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Bookmark', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.bookmark.delete',
    title: 'Remove a message bookmark',
    description: 'Remove your bookmark from a message. Confirm-class.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Unbookmark', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.pin.set',
    title: 'Pin a message',
    description: 'Pin a message for the whole conversation. Confirm-class.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Pin', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.pin.delete',
    title: 'Unpin a message',
    description: 'Unpin a message for the whole conversation. Confirm-class.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Unpin', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.reactions.list',
    title: 'List message reactions',
    description: 'The emoji reactions on a message.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'Reactions', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.reactions.set',
    title: 'React to a message',
    description: 'Add an emoji reaction to a message.',
    input: bodyArgs(['conversationId', 'messageId'], { emoji: f.shortText(40) }),
    redact: 'standard',
    examples: [
      {
        summary: 'Thumbs up',
        args: { conversationId: 'conv_123', messageId: 'msg_5', emoji: '👍' },
      },
    ],
  }),
  det({
    id: 'conversations.messages.reactions.delete',
    title: 'Remove a reaction',
    description: 'Remove your emoji reaction from a message. Confirm-class.',
    input: pathOnly('conversationId', 'messageId', 'emoji'),
    redact: 'standard',
    examples: [
      { summary: 'Remove', args: { conversationId: 'conv_123', messageId: 'msg_5', emoji: '👍' } },
    ],
  }),
  det({
    id: 'conversations.reactions.list',
    title: 'List reactions on several messages',
    description: 'The emoji reactions on several messages of one conversation, in one read.',
    input: bodyArgs(['conversationId'], { messageIds: f.shortText(7_400) }),
    redact: 'standard',
    examples: [
      { summary: 'Two messages', args: { conversationId: 'conv_123', messageIds: 'msg_5,msg_6' } },
    ],
  }),
  det({
    id: 'conversations.attachments.list',
    title: 'List attachments on several messages',
    description:
      'The files attached to several messages of one conversation, in one read, each with its virus-scan status.',
    input: bodyArgs(['conversationId'], { messageIds: f.shortText(7_400) }),
    redact: 'standard',
    examples: [
      { summary: 'Two messages', args: { conversationId: 'conv_123', messageIds: 'msg_5,msg_6' } },
    ],
  }),
  det({
    id: 'conversations.link_previews.list',
    title: 'List link previews',
    description:
      'The link previews (title, site, description) of up to 50 messages of a conversation.',
    input: bodyArgs(['conversationId'], { messageIds: f.shortText(1_900) }),
    redact: 'standard',
    examples: [
      { summary: 'Two messages', args: { conversationId: 'conv_123', messageIds: 'msg_5,msg_6' } },
    ],
  }),
  det({
    id: 'conversations.messages.forward.create',
    title: 'Forward a message',
    description:
      'Copy a message into up to five other conversations you can post in. Their members are notified.',
    input: bodyArgs(['conversationId', 'messageId'], {
      targetConversationIds: z.array(f.id()).min(1).max(5),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Forward to one chat',
        args: { conversationId: 'conv_123', messageId: 'msg_5', targetConversationIds: ['conv_9'] },
      },
    ],
  }),
  det({
    id: 'conversations.messages.revisions.list',
    title: 'List message edit history',
    description: 'The edit history of a message.',
    input: pathOnly('conversationId', 'messageId'),
    redact: 'standard',
    examples: [{ summary: 'History', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.thread.list',
    title: 'List thread replies',
    description: 'The replies in a message thread.',
    input: queryArgs(['conversationId', 'messageId']),
    redact: 'standard',
    examples: [{ summary: 'Thread', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.thread.create',
    title: 'Reply in a thread',
    description: 'Post a reply in a message thread. Thread participants are notified.',
    // = thread-replies.controller.ts `replyBody`: plain text, non-empty, up to 16 000 characters.
    input: bodyArgs(['conversationId', 'messageId'], { body: f.text(16_000) }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Reply', args: { conversationId: 'conv_123', messageId: 'msg_5', body: 'On it' } },
    ],
  }),
  det({
    id: 'conversations.messages.work_items.create',
    title: 'Create a work item from a message',
    description: 'Turn a message into a tracked work item.',
    input: bodyArgs(['conversationId', 'messageId'], {
      title: f.shortText(300).optional(),
      projectId: f.id().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'To task',
        args: { conversationId: 'conv_123', messageId: 'msg_5', title: 'Follow up' },
      },
    ],
  }),
  det({
    id: 'conversations.messages.search.list',
    title: 'Search messages in a conversation',
    description: 'Search within one conversation for messages matching a query.',
    input: listArgs(['conversationId'], { q: f.shortText(500) }, { cursor: 'page' }),
    redact: 'standard',
    examples: [{ summary: 'Find', args: { conversationId: 'conv_123', q: 'deadline' } }],
  }),
  det({
    id: 'conversations.mute.list',
    title: 'Get your mute setting',
    description: 'Whether you have muted this conversation.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'Mute state', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.mute.set',
    title: 'Mute or unmute a conversation',
    description: 'Mute or unmute this conversation for yourself.',
    input: bodyArgs(['conversationId'], { muted: f.bool() }),
    redact: 'standard',
    examples: [{ summary: 'Mute', args: { conversationId: 'conv_123', muted: true } }],
  }),
  det({
    id: 'conversations.pins.list',
    title: 'List pinned messages',
    description: 'The pinned messages in a conversation.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'Pins', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.read_state.list',
    title: 'Get conversation read state',
    description: 'How far you have read in a conversation.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    examples: [{ summary: 'Read state', args: { conversationId: 'conv_123' } }],
  }),
  det({
    id: 'conversations.read_state.set',
    title: 'Mark a conversation read',
    description: 'Mark a conversation read up to a given message, for yourself.',
    input: bodyArgs(['conversationId'], { lastReadMessageId: f.id() }),
    redact: 'standard',
    examples: [
      { summary: 'Mark read', args: { conversationId: 'conv_123', lastReadMessageId: 'msg_5' } },
    ],
  }),
  det({
    id: 'conversations.directory.list',
    title: 'Browse the channel directory',
    description:
      'The channels you can reach (archived included), with members and last activity, newest ' +
      'activity first.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Directory', args: {} }],
  }),
  det({
    id: 'conversations.read_state.list.get',
    title: 'Get read state across conversations',
    description: 'Your unread counts across all conversations.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All unread', args: {} }],
  }),
  // BK3 (COL-02 / COL-03).
  det({
    id: 'conversations.mention_candidates.list',
    title: 'Find people to mention',
    description:
      'People who can read this conversation whose name starts with q. Insert the returned ' +
      'mention token in a message to notify them.',
    input: listArgs(['conversationId'], { q: f.shortText(100).optional() }, { cursor: null }),
    redact: 'standard',
    examples: [
      { summary: 'Names starting with sa', args: { conversationId: 'conv_123', q: 'sa' } },
    ],
  }),
  det({
    id: 'conversations.direct.list',
    title: 'List your direct conversations',
    description: 'Your one-to-one conversations with other members, most recent first.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'conversations.direct.create',
    title: 'Open a direct conversation',
    description:
      'Open (or get the existing) one-to-one conversation with another member. Clients can ' +
      'only message people they share a project with.',
    input: bodyArgs([], { userId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Open', args: { userId: 'user_123' } }],
  }),
  det({
    id: 'conversations.direct.messages.list',
    title: 'List direct messages',
    description: 'Messages in a direct conversation. Message text is untrusted member content.',
    input: listArgs(
      ['directConversationId'],
      {
        afterSequenceNo: z.number().int().min(0).optional(),
      },
      { cursor: null },
    ),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: { directConversationId: 'dm_123', limit: 30 } }],
  }),
  det({
    id: 'conversations.direct.messages.create',
    title: 'Send a direct message',
    description: 'Post a message in a direct conversation. The other person can read it.',
    input: bodyArgs(['directConversationId'], {
      body: f.text(16_000),
      clientGeneratedId: f.id(36).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Say hi', args: { directConversationId: 'dm_123', body: 'Hi!' } }],
  }),
  det({
    id: 'conversations.direct.read_state.set',
    title: 'Mark a direct conversation read',
    description:
      'Mark a direct conversation read for yourself, up to a message sequence number or to the ' +
      'latest message when none is given. Never moves backwards.',
    input: bodyArgs(['directConversationId'], {
      lastReadSequenceNo: z.number().int().min(0).optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'All read', args: { directConversationId: 'dm_123' } },
      { summary: 'Up to 12', args: { directConversationId: 'dm_123', lastReadSequenceNo: 12 } },
    ],
  }),
];
