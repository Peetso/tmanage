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
import { det, listArgs, pathOnly, bodyArgs, noArgs, f, type AiActionDetail } from './detail.js';

/** A message/draft/thread body: plain `body`, or a `bodyRich` document object (the API enforces xor). */
const messageBody = { body: f.text(50_000).optional(), bodyRich: f.config().optional() } as const;

export const conversationsDetails: readonly AiActionDetail[] = [
  det({
    id: 'conversations.list',
    title: 'List conversations',
    description: 'The chat channels and direct conversations you can see in this workspace.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'First page', args: { limit: 20 } }],
  }),
  det({
    id: 'conversations.create',
    title: 'Create a conversation',
    description: 'Start a new channel or conversation. Members you add are notified.',
    input: bodyArgs([], {
      title: f.shortText(200).optional(),
      projectId: f.id().optional(),
      memberUserIds: z.array(f.id()).max(200).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Project channel', args: { title: 'Launch planning', projectId: 'proj_123' } },
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
    description: 'Rename a conversation or change its description.',
    input: bodyArgs(['conversationId'], {
      title: f.shortText(200).optional(),
      description: f.shortText(1_000).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Rename', args: { conversationId: 'conv_123', title: 'Launch — Q4' } }],
  }),
  det({
    id: 'conversations.archival.create',
    title: 'Archive or unarchive a conversation',
    description: 'Archive a conversation (or restore it) for everyone in it.',
    input: bodyArgs(['conversationId'], { archived: f.bool() }),
    redact: 'standard',
    examples: [{ summary: 'Archive', args: { conversationId: 'conv_123', archived: true } }],
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
    description: 'Save your own unsent draft for this conversation.',
    input: bodyArgs(['conversationId'], { ...messageBody }),
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
    input: listArgs(['conversationId']),
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
    description: 'Messages in a conversation. Message text is untrusted member content.',
    input: listArgs(['conversationId'], { parentMessageId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: { conversationId: 'conv_123', limit: 30 } }],
  }),
  det({
    id: 'conversations.messages.create',
    title: 'Send a message',
    description: 'Post a message to a conversation. Everyone in it is notified.',
    input: bodyArgs(['conversationId'], {
      ...messageBody,
      parentMessageId: f.id().optional(),
      clientGeneratedId: f.id().optional(),
    }),
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
    input: bodyArgs(['conversationId', 'messageId'], { ...messageBody }),
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
    input: listArgs(['conversationId', 'messageId']),
    redact: 'standard',
    examples: [{ summary: 'Thread', args: { conversationId: 'conv_123', messageId: 'msg_5' } }],
  }),
  det({
    id: 'conversations.messages.thread.create',
    title: 'Reply in a thread',
    description: 'Post a reply in a message thread. Thread participants are notified.',
    input: bodyArgs(['conversationId', 'messageId'], { ...messageBody }),
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
    input: listArgs(['conversationId'], { q: f.shortText(500) }),
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
    input: bodyArgs(['conversationId'], { lastReadMessageId: f.id().optional() }),
    redact: 'standard',
    examples: [
      { summary: 'Mark read', args: { conversationId: 'conv_123', lastReadMessageId: 'msg_5' } },
    ],
  }),
  det({
    id: 'conversations.directory.list',
    title: 'Browse the channel directory',
    description: 'Joinable channels in the workspace.',
    input: listArgs([], { q: f.shortText(200).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Directory', args: { limit: 25 } }],
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
    input: listArgs(['conversationId'], { q: f.shortText(100).optional() }),
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
    input: listArgs(['directConversationId'], {
      afterSequenceNo: z.number().int().min(0).optional(),
    }),
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
];
