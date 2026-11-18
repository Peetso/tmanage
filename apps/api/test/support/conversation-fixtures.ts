/**
 * R7 (0275): the columns a pre-R7 conversation or message fixture lacks, at their defaults — a
 * project channel with no group settings, and a plain text message with no meta.
 */
export const CHANNEL_ROW_DEFAULTS = {
  kind: 'project_channel',
  directUserLowId: null,
  directUserHighId: null,
  photoFileAssetId: null,
  description: null,
  onlyAdminsCanSend: false,
  inviteToken: null,
  lastMessageId: null,
  lastMessageAt: null,
} as const;

export const CHANNEL_VIEW_DEFAULTS = {
  kind: 'project_channel',
  photoFileAssetId: null,
  description: null,
  settings: { onlyAdminsCanSend: false },
  lastMessageAt: null,
} as const;

export const MESSAGE_ROW_DEFAULTS = { kind: 'text', metaJson: null } as const;
