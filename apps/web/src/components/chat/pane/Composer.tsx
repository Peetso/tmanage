'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { InadmissibleRichTextError, sanitizeRichText } from '@tmanage/domain';
import { InlineAlert } from '@tmanage/ui';
import {
  MentionButton,
  MentionPicker,
  useMentionComposer,
  type MentionGroup,
} from '../MentionPicker';
import { RichTextBody } from '../../RichTextBody';
import { PhoneIcon } from '../../icons/phone';
import { newCorrelationId } from '../../../lib/api/client';
import type { ApiClient } from '../../../lib/api/client';
import { clearDraft, getDraft, postMessage, saveDraft } from '../../../lib/api/conversations';
import type { MessageSummary, PostMessageInput, ReplyMeta } from '../../../lib/api/conversations';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { attachMessageFile } from '../../../lib/api/message-attachments';
import { deleteFile } from '../../../lib/api/file-delete';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  attachmentProblem,
  formatBytes,
  UploadFailedError,
  uploadProjectFile,
} from '../../../lib/api/uploads';
import { composeMessage } from '../../../lib/rich-composer';
import { transcriptHoldsAttempt } from '../../../lib/sent-attempt';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useDictation } from '../../voice/useDictation';
import { MicButton, MicNotice } from '../../voice/VoiceControls';
import { EmojiPicker } from './EmojiPicker';
import { ReplyQuote } from './ReplyQuote';
import { UploadMeter } from '../../storage/UploadProgress';
import './pane.css';

type Translate = ReturnType<typeof useT>;
type TranslateOr = (key: string, english: string) => string;

/**
 * FIX3 item 1. The message went out, but a file could not be linked to it. The text is in the
 * transcript, so the composer clears it and keeps the files for another try — never silent.
 */
export class FilesNotAttachedError extends Error {
  constructor(readonly fileNames: readonly string[]) {
    super('files_not_attached');
    this.name = 'FilesNotAttachedError';
  }
}

/**
 * FIX5 item 3 (B-N3). The API refused one of the message's files before any byte moved (a 422
 * `file_not_allowed` with a reason token). Nothing was sent: the files already uploaded for this
 * message were removed again, the text stays in the box, and the refused file leaves the list.
 */
export class FileRefusedError extends Error {
  constructor(
    readonly fileName: string,
    readonly reason: string,
    /** FIX5 M2: the entry inside a refused ZIP the refusal is about, when the API named one. */
    readonly entry: string | null = null,
  ) {
    super(`file_not_allowed:${reason}`);
    this.name = 'FileRefusedError';
  }
}

/**
 * The refusal reason token from the upload session's 422 (`file_not_allowed`, whose one detail is
 * `{ field: 'reason', message: <token> }`), or `null` for any other error. The web client keeps
 * only the generic codes, so the status and the detail decide.
 */
export function refusalReason(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 422) return null;
  const token = error.details.find((detail) => detail.field === 'reason')?.message;
  if (token !== undefined && Object.hasOwn(REFUSAL_ENGLISH, token)) return token;
  return token !== undefined || error.message === 'This file cannot be uploaded'
    ? 'type_not_allowed'
    : null;
}

/**
 * FIX5 M2. The refusal behind an upload: the 422 at session time (`refusalReason`, with an
 * optional `{ field: 'entry' }` detail), or the verifier's verdict once the bytes were read — a
 * `rejected` file whose answer carries a known reason token (and, for a ZIP, the entry). `null`
 * for any other failure, which keeps its own message.
 */
export function uploadRefusal(
  error: unknown,
): { readonly reason: string; readonly entry: string | null } | null {
  if (
    error instanceof UploadFailedError &&
    error.reason === 'rejected' &&
    error.rejectionCode !== null &&
    Object.hasOwn(REFUSAL_ENGLISH, error.rejectionCode)
  ) {
    return { reason: error.rejectionCode, entry: error.rejectedEntry };
  }
  const reason = refusalReason(error);
  if (reason === null) return null;
  const entry =
    error instanceof ApiRequestError
      ? (error.details.find((detail) => detail.field === 'entry')?.message ?? null)
      : null;
  return { reason, entry };
}

const REFUSAL_ENGLISH: Readonly<Record<string, string>> = {
  executable: '“{name}” is a program, and programs cannot be shared in TManage.',
  macro_office:
    '“{name}” contains macros, which TManage does not accept. Save it without macros (for example as .docx or .xlsx) and attach it again.',
  archive_off:
    '“{name}” is an archive, and archives (ZIP, 7z, RAR) are turned off for this workspace.',
  double_extension:
    '“{name}” has two file types in its name, which TManage refuses for safety. Rename it and attach it again.',
  type_not_allowed: '“{name}” is a file type this workspace does not accept.',
  too_large: '“{name}” is larger than this workspace allows.',
  channel_forbids: '“{name}” cannot be shared here.',
  archive_contains_blocked:
    '“{name}” contains “{entry}”, a program, script or macro file, which TManage does not accept. Remove it from the archive and attach it again.',
  archive_nested:
    '“{name}” contains another archive, “{entry}”. TManage looks inside one level only: unpack it, or send the inner archive on its own.',
  archive_encrypted:
    '“{name}” contains a password-protected file, “{entry}”, which TManage cannot check. Send it without a password.',
  archive_unreadable: 'TManage could not look inside “{name}”, so it cannot be shared.',
};

function describeError(error: unknown, t: Translate, tOr: TranslateOr): string {
  if (error instanceof FileRefusedError) {
    const reason = REFUSAL_ENGLISH[error.reason] ? error.reason : 'type_not_allowed';
    const why = tOr(`ChatMessages.refused.${reason}`, REFUSAL_ENGLISH[reason] as string)
      .replace('{name}', error.fileName)
      .replace('{entry}', error.entry ?? '…');
    return `${why} ${tOr(
      'ChatMessages.refused.nothingSent',
      'Nothing was sent; your message and the other files are still here.',
    )}`;
  }
  if (error instanceof UploadFailedError) {
    const name = error.fileName;
    const english: Record<UploadFailedError['reason'], string> = {
      busy: 'TManage was busy and “{name}” did not upload. Nothing was sent — try again in a moment.',
      rejected: '“{name}” did not pass the safety check, so it cannot be shared. Nothing was sent.',
      still_checking:
        '“{name}” is still being checked for safety. Nothing was sent — try again in a minute.',
      refused:
        '“{name}” could not be uploaded. Nothing was sent. If this keeps happening, ask your workspace owner to check Control › Storage.',
    };
    return tOr(`ChatMessages.upload.${error.reason}`, english[error.reason]).replace(
      '{name}',
      name,
    );
  }
  if (error instanceof FilesNotAttachedError) {
    return tOr(
      'ChatMessages.upload.notAttached',
      'Your message was sent, but “{name}” was not added to it. Send again to share the file.',
    ).replace('{name}', error.fileNames.join('”, “'));
  }
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectChannelScreen.apiError');
  return t('ProjectChannelScreen.genericError');
}

/** R7 slice 4: the message a reply quotes, with its author's display name. */
export interface ComposerReplyTarget {
  readonly message: MessageSummary;
  readonly authorName: string;
}

/** The quote facts a reply carries (the API caps the excerpt at 280 characters). */
export function replyMetaFor(target: MessageSummary): ReplyMeta {
  const excerpt = (target.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 280);
  return { replyToMessageId: target.id, authorUserId: target.authorUserId, excerpt };
}

/**
 * The formatting a toolbar button applies: wrap the selection inline, prefix the selected
 * lines, or fence them. All three edit the *notation* in the textarea — the person always
 * sees exactly what will be converted, and the preview shows what it converts to.
 */
type ToolbarEdit =
  | { readonly kind: 'wrap'; readonly before: string; readonly after: string }
  | { readonly kind: 'prefix'; readonly marker: string }
  | { readonly kind: 'fence' };

const TOOLBAR: readonly { labelKey: MessageKey; glyph: string; edit: ToolbarEdit }[] = [
  {
    labelKey: 'ProjectChannelScreen.toolbarBold',
    glyph: 'B',
    edit: { kind: 'wrap', before: '**', after: '**' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarItalic',
    glyph: 'I',
    edit: { kind: 'wrap', before: '_', after: '_' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarStrikethrough',
    glyph: 'S',
    edit: { kind: 'wrap', before: '~~', after: '~~' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarCode',
    glyph: '`',
    edit: { kind: 'wrap', before: '`', after: '`' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarLink',
    glyph: '↗',
    edit: { kind: 'wrap', before: '[', after: '](https://)' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarQuote',
    glyph: '❝',
    edit: { kind: 'prefix', marker: '> ' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarBulletedList',
    glyph: '•',
    edit: { kind: 'prefix', marker: '- ' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarNumberedList',
    glyph: '1.',
    edit: { kind: 'prefix', marker: '1. ' },
  },
  { labelKey: 'ProjectChannelScreen.toolbarCodeBlock', glyph: '{}', edit: { kind: 'fence' } },
];

/** Apply one toolbar edit to the draft at the current selection. Returns the new draft. */
function applyToolbarEdit(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  edit: ToolbarEdit,
): string {
  const before = draft.slice(0, selectionStart);
  const selected = draft.slice(selectionStart, selectionEnd);
  const after = draft.slice(selectionEnd);

  if (edit.kind === 'wrap') {
    return `${before}${edit.before}${selected || 'text'}${edit.after}${after}`;
  }
  if (edit.kind === 'prefix') {
    // Prefix every line the selection touches, from the start of its first line.
    const lineStart = before.lastIndexOf('\n') + 1;
    const head = draft.slice(0, lineStart);
    const target = draft.slice(lineStart, selectionEnd) || 'text';
    const prefixed = target
      .split('\n')
      .map((line) => `${edit.marker}${line}`)
      .join('\n');
    return `${head}${prefixed}${after}`;
  }
  const block = selected || 'code';
  const openFence = before === '' || before.endsWith('\n') ? '```\n' : '\n```\n';
  return `${before}${openFence}${block}\n\`\`\`\n${after}`;
}

/**
 * A7: add picked or dropped files to the pending list. Files that cannot be attached (empty,
 * too large, a type the upload verifier refuses) and anything past `MAX_ATTACHMENTS` are left
 * out; the first reason is answered so the composer can show it.
 */
export function addPendingFiles(
  pending: readonly File[],
  incoming: readonly File[],
): { readonly files: File[]; readonly problem: string | undefined; readonly tooMany: boolean } {
  const files = [...pending];
  let problem: string | undefined;
  let tooMany = false;
  for (const file of incoming) {
    const reason = attachmentProblem(file);
    if (reason !== null) {
      problem ??= reason;
      continue;
    }
    if (files.length >= MAX_ATTACHMENTS) {
      tooMany = true;
      break;
    }
    files.push(file);
  }
  return { files, problem, tooMany };
}

/**
 * The composer, used by the channel and by the thread pane. One component so the dedupe
 * behaviour — mint the id when a send starts, keep it until that send succeeds — cannot
 * drift between the two.
 *
 * ## The rich half — WEB-003's second half
 *
 * The toolbar writes the composer's notation into the textarea; `composeMessage` converts
 * it to CHAT-002's closed grammar; the preview renders the converted document through the
 * same `RichTextBody` the transcript uses, so what is previewed is what a reader will see —
 * not a second renderer's opinion. A draft that uses no notation is sent as plain `body`,
 * exactly as before. Before a rich send, `sanitizeRichText` — the domain's own gate, the
 * same one the API applies — runs here so an inadmissible document is refused with its
 * path *before* the network, not after. No HTML exists at any point in this path.
 */
export function Composer({
  api,
  organizationSlug,
  conversationId,
  archived,
  label,
  placeholder,
  parentMessageId,
  mentions,
  replyTo,
  onCancelReply,
  extras = false,
  voice,
  attachProjectId,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  archived: boolean;
  label: string;
  placeholder?: string;
  parentMessageId?: string;
  /** A4 (m-mention): the channel composer's @ picker. Absent on a thread reply. */
  mentions?: {
    projectMemberIds: ReadonlySet<string>;
    subtitleOf: (userId: string, group: MentionGroup) => string | undefined;
  };
  /** R7 slice 4: the message being quoted; the next send carries `meta` with the reply. */
  replyTo?: ComposerReplyTarget;
  onCancelReply?: () => void;
  /** R7 slice 4: emoji and location buttons on the channel composer. */
  extras?: boolean;
  /** R7 slice 4: slice 5's voice-note recorder, beside Send. */
  voice?: ReactNode;
  /**
   * A7: the project the channel's files are stored under. When given, the channel composer shows
   * an attach button and accepts dropped files; each file is uploaded through the ordinary upload
   * session (so the virus scan runs) and linked to the message on send. `null` is a conversation
   * without a project: the button is shown disabled.
   */
  attachProjectId?: string | null;
}) {
  const queries = useQueryClient();
  const t = useT();
  const [draft, setDraft] = useState('');
  const dictation = useDictation({
    value: draft,
    onChange: (next) => setDraft(next.slice(0, 16000)),
  });
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const [inadmissible, setInadmissible] = useState<string | undefined>(undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // SMALLFIX item 1: bytes sent so far per file of the send in flight (index-aligned with the
  // files it sends); `null` while nothing is uploading.
  const [sentBytes, setSentBytes] = useState<readonly number[] | null>(null);
  const [fileProblem, setFileProblem] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);
  const tOr = useTOr();
  const mention = useMentionComposer({
    api,
    organizationSlug,
    conversationId,
    draft,
    setDraft,
    controlRef,
    ...(mentions === undefined
      ? {}
      : { projectMemberIds: mentions.projectMemberIds, subtitleOf: mentions.subtitleOf }),
  });
  const mentionsOn = mentions !== undefined;

  // x251. Only the channel composer persists an unsent draft; a thread reply is transient and
  // has no per-thread draft on the server (the draft is keyed to the conversation). The notation
  // in the textarea is what is saved verbatim, so what is restored is exactly what was typed.
  const persistDraft = parentMessageId === undefined;
  const restoredRef = useRef(false);
  // 2026-10-31 live-test fix: a send clears the stored draft itself, at once. The emptied box then
  // must not fire a second, debounced DELETE for the same draft — two DELETEs back to back is what
  // the live test saw answered 503 by the host under load.
  const clearedOnSendRef = useRef(false);

  // Restore the saved draft once, on open, and never over text the author has already started —
  // the seed only ever fills an empty box.
  useEffect(() => {
    if (!persistDraft || restoredRef.current) return;
    let cancelled = false;
    void getDraft(api, organizationSlug, conversationId)
      .then((saved) => {
        if (cancelled) return;
        restoredRef.current = true;
        if (typeof saved.body === 'string' && saved.body !== '') {
          setDraft((current) => (current === '' ? (saved.body as string) : current));
        }
      })
      .catch(() => {
        // A draft that cannot be loaded is not worth surfacing: the composer opens empty, which
        // is the same state as "no draft", and the send path is unaffected.
        restoredRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [api, organizationSlug, conversationId, persistDraft]);

  // Save what is typed, debounced, once the restore has settled so a save cannot race the seed.
  // An emptied box clears the stored draft; a non-empty one upserts it. A failed save is silent —
  // the draft is a convenience, not the message, and the next keystroke tries again.
  useEffect(() => {
    if (!persistDraft || !restoredRef.current) return;
    if (draft !== '') clearedOnSendRef.current = false;
    else if (clearedOnSendRef.current) {
      clearedOnSendRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const write =
        draft === ''
          ? clearDraft(api, organizationSlug, conversationId)
          : saveDraft(api, organizationSlug, conversationId, draft);
      void Promise.resolve(write).catch(() => {});
    }, 800);
    return () => clearTimeout(handle);
  }, [draft, api, organizationSlug, conversationId, persistDraft]);

  // Picked names go out as the API's mention tokens (`@<userId>`).
  const encodeMentions = mention.encode;
  const composed = useMemo(
    () => (draft.trim() === '' ? undefined : composeMessage(encodeMentions(draft))),
    [draft, encodeMentions],
  );

  const send = useMutation({
    mutationFn: async (input: PostMessageInput & { readonly files?: readonly File[] }) => {
      const { files = [], ...message } = input;
      // A7: the files are uploaded first (each through its own upload session, so the scan
      // runs), then the message is posted, then each file is linked to it.
      const fileIds: string[] = [];
      if (files.length > 0 && typeof attachProjectId === 'string') {
        setSentBytes(files.map(() => 0));
        for (const [index, file] of files.entries()) {
          try {
            fileIds.push(
              // Wait for the safety scan: a file still being checked cannot be linked (404).
              await uploadProjectFile(
                api,
                organizationSlug,
                { projectId: attachProjectId, file },
                {
                  untilReady: true,
                  onProgress: (sent) =>
                    setSentBytes((all) =>
                      all ? all.map((value, at) => (at === index ? sent : value)) : all,
                    ),
                },
              ),
            );
          } catch (error) {
            // FIX5 item 3 (B-N3): one file failed, so the message is not sent. The files already
            // uploaded for it are removed again (no orphans on Files, no duplicates on a retry).
            // One at a time, each tried twice: parallel deletes contend on the audit chain and
            // one of them could fail and leave its file behind.
            for (const id of fileIds) {
              await deleteFile(api, organizationSlug, id).catch(() =>
                deleteFile(api, organizationSlug, id).catch(() => undefined),
              );
            }
            const refusal = uploadRefusal(error);
            if (refusal !== null) {
              throw new FileRefusedError(file.name, refusal.reason, refusal.entry);
            }
            throw error;
          }
        }
      }
      const posted = await postMessage(api, organizationSlug, conversationId, {
        ...message,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
        ...(replyTo === undefined || message.kind !== undefined
          ? {}
          : { meta: { ...replyMetaFor(replyTo.message) } }),
      });
      const missing: string[] = [];
      for (const [index, fileId] of fileIds.entries()) {
        try {
          await attachMessageFile(api, organizationSlug, conversationId, posted.id, fileId);
        } catch {
          missing.push(files[index]?.name ?? '');
        }
      }
      // FIX5 item 4 (B-N4): the message row may already have read its attachments while the
      // files were still being linked (2 of 4). Read them again now that every link is made.
      if (fileIds.length > 0) {
        void queries.invalidateQueries({
          queryKey: ['message-attachments', organizationSlug, conversationId, posted.id],
        });
      }
      if (missing.length > 0) throw new FilesNotAttachedError(missing);
      return posted;
    },
    onSettled: () => setSentBytes(null),
    onError: (error) => {
      if (error instanceof FileRefusedError) {
        // The text and the other files stay; only the refused file leaves the list.
        setPendingFiles((files) => files.filter((file) => file.name !== error.fileName));
        return;
      }
      if (!(error instanceof FilesNotAttachedError)) return;
      // The text is posted: clear it so it is not sent twice, keep only the files not added.
      if (persistDraft) clearedOnSendRef.current = true;
      setDraft('');
      setAttemptId(undefined);
      setPendingFiles((files) => files.filter((file) => error.fileNames.includes(file.name)));
      if (persistDraft) void clearDraft(api, organizationSlug, conversationId).catch(() => {});
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
    onSuccess: () => {
      onCancelReply?.();
      if (persistDraft) clearedOnSendRef.current = true;
      setDraft('');
      setPendingFiles([]);
      setFileProblem(undefined);
      setAttemptId(undefined);
      // The message is sent, so its draft is spent — clear it so a reopen does not restore text
      // that is already in the transcript.
      if (persistDraft) void clearDraft(api, organizationSlug, conversationId).catch(() => {});
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  // ACCOUNT item 2: a send the browser gave up on (a network failure or timeout) may still have
  // reached the API. The stored message carries the attempt's id, so once the transcript shows
  // it the send is settled as sent: no "Not sent", and the next message gets a fresh id. Text
  // edited since the send stays in the box (it is a new message). With files the retry is left
  // to the person: replaying the same id links the files to the stored message.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sentDraftRef = useRef<string | undefined>(undefined);
  const cancelReplyRef = useRef(onCancelReply);
  cancelReplyRef.current = onCancelReply;
  const resetSend = send.reset;
  const lostAttempt =
    send.isError && send.error instanceof NetworkError && pendingFiles.length === 0
      ? attemptId
      : undefined;
  useEffect(() => {
    if (lostAttempt === undefined) return undefined;
    const transcriptKey = ['messages', organizationSlug, conversationId];
    let settled = false;
    const settleIfStored = () => {
      if (settled) return;
      const stored = queries
        .getQueriesData({ queryKey: transcriptKey })
        .some(([, data]) => transcriptHoldsAttempt(data, lostAttempt));
      if (!stored) return;
      settled = true;
      if (draftRef.current === sentDraftRef.current) {
        cancelReplyRef.current?.();
        if (persistDraft) clearedOnSendRef.current = true;
        setDraft('');
        if (persistDraft) void clearDraft(api, organizationSlug, conversationId).catch(() => {});
      }
      setAttemptId(undefined);
      resetSend();
    };
    const unsubscribe = queries.getQueryCache().subscribe(settleIfStored);
    settleIfStored();
    if (!settled) void queries.invalidateQueries({ queryKey: transcriptKey });
    return unsubscribe;
  }, [lostAttempt, queries, organizationSlug, conversationId, api, persistDraft, resetSend]);

  // ACCOUNT item 1: a shared location is a message of its own. It has its own mutation so its
  // success never runs the send-success path above: the text being typed and the files waiting
  // to go stay exactly as they are.
  const sendLocation = useMutation({
    mutationFn: (input: PostMessageInput) =>
      postMessage(api, organizationSlug, conversationId, {
        ...input,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    performSend();
  }

  /**
   * COL-13: Enter sends; Shift+Enter inserts a newline. The guard against `isComposing` keeps an
   * IME mid-composition Enter (choosing a candidate) from sending, so composing Arabic, Japanese or
   * any other input method is unaffected. Any modifier (Ctrl/Cmd/Alt) is left to the browser.
   */
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionsOn && mention.onKeyDown(event)) return;
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      performSend();
    }
  }

  function performSend() {
    if ((composed === undefined && pendingFiles.length === 0) || send.isPending) return;
    setInadmissible(undefined);

    let content: Pick<PostMessageInput, 'body' | 'bodyRich'>;
    if (composed === undefined) {
      // A7: files without text still need a body; the file names are what a reader sees.
      content = { body: pendingFiles.map((file) => file.name).join(', ') };
    } else if (composed.kind === 'plain') {
      content = { body: composed.body.trim() };
    } else {
      try {
        // The same refusal the API would give, raised before the network so the path to
        // the offending node points at something the author can still edit.
        content = { bodyRich: sanitizeRichText(composed.document) };
      } catch (error) {
        setInadmissible(
          error instanceof InadmissibleRichTextError
            ? error.message
            : t('ProjectChannelScreen.cannotFormat'),
        );
        return;
      }
    }

    // Reuse the attempt id when this is a retry of a failed send; mint one otherwise.
    const clientGeneratedId = attemptId ?? newCorrelationId();
    setAttemptId(clientGeneratedId);
    sentDraftRef.current = draft;
    send.mutate({
      ...content,
      clientGeneratedId,
      ...(pendingFiles.length > 0 ? { files: pendingFiles } : {}),
    });
  }

  const attachOn = attachProjectId !== undefined && parentMessageId === undefined;
  const canAttach = attachOn && typeof attachProjectId === 'string';

  function addFiles(incoming: readonly File[]) {
    if (!canAttach || incoming.length === 0) return;
    const next = addPendingFiles(pendingFiles, incoming);
    setPendingFiles(next.files);
    setFileProblem(
      next.tooMany
        ? tOr(
            'ChatMessages.attachTooMany',
            'At most {count} files can go with one message.',
          ).replace('{count}', String(MAX_ATTACHMENTS))
        : next.problem,
    );
    setAttemptId(undefined);
  }

  function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    // Clear the input so picking the same file again still fires a change.
    event.target.value = '';
  }

  function removePendingFile(index: number) {
    setPendingFiles((files) => files.filter((_, at) => at !== index));
    setFileProblem(undefined);
    setAttemptId(undefined);
    // The failed send was about these files; with one removed its banner no longer applies.
    if (send.isError) send.reset();
  }

  const dropProps = canAttach
    ? {
        onDragOver: (event: DragEvent<HTMLFormElement>) => {
          if (!Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!dragging) setDragging(true);
        },
        onDragLeave: (event: DragEvent<HTMLFormElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        },
        onDrop: (event: DragEvent<HTMLFormElement>) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  function applyEdit(edit: ToolbarEdit) {
    const control = controlRef.current;
    const start = control?.selectionStart ?? draft.length;
    const end = control?.selectionEnd ?? draft.length;
    setDraft(applyToolbarEdit(draft, start, end, edit));
    control?.focus();
  }

  function insertEmoji(emoji: string) {
    const control = controlRef.current;
    const start = control?.selectionStart ?? draft.length;
    const end = control?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`.slice(0, 16000));
    setEmojiOpen(false);
    control?.focus();
  }

  /** R7 slice 4: the browser's position, posted as `kind='location'` (coordinates + OSM link). */
  function shareLocation() {
    setLocationError(false);
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setLocationError(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude.toFixed(6));
        const lng = Number(position.coords.longitude.toFixed(6));
        const label = tOr('ChatMessages.myLocation', 'My location');
        sendLocation.mutate({
          kind: 'location',
          body: `${label}: ${lat}, ${lng}`,
          meta: { lat, lng, label },
          clientGeneratedId: newCorrelationId(),
        });
      },
      () => setLocationError(true),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  const extraButtons = extras ? (
    <span className="tm-pane-composer-extras">
      <button
        type="button"
        className="tm-chat-side__round"
        aria-label={tOr('ChatMessages.emoji', 'Emoji')}
        title={tOr('ChatMessages.emoji', 'Emoji')}
        aria-expanded={emojiOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setEmojiOpen((open) => !open)}
      >
        <span aria-hidden="true">☺</span>
      </button>
      <button
        type="button"
        className="tm-chat-side__round"
        aria-label={tOr('ChatMessages.shareLocation', 'Share location')}
        title={tOr('ChatMessages.shareLocation', 'Share location')}
        disabled={sendLocation.isPending}
        aria-busy={sendLocation.isPending}
        onClick={shareLocation}
      >
        <span aria-hidden="true">📍</span>
      </button>
      {emojiOpen ? (
        <EmojiPicker mode="insert" onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
      ) : null}
    </span>
  ) : null;

  const controlId = parentMessageId === undefined ? 'tm-composer' : 'tm-thread-composer';
  // A16: the channel composer is the Figma's "+ · @ · →" card — the formatting toolbar sits
  // behind "+" — while the thread reply keeps its full toolbar, dictation and labelled Send.
  const channelStyle = parentMessageId === undefined;
  const toolbar = (
    <div
      className="tm-chat-composer__tools"
      role="group"
      aria-label={t('ProjectChannelScreen.formattingGroup')}
    >
      {TOOLBAR.map((tool) => (
        <button
          key={tool.labelKey}
          type="button"
          className="tm-chat-composer__tool"
          aria-label={t(tool.labelKey)}
          title={t(tool.labelKey)}
          onClick={() => applyEdit(tool.edit)}
        >
          <span aria-hidden="true">{tool.glyph}</span>
        </button>
      ))}
    </div>
  );

  if (archived) {
    return <p className="tm-chat-archived">{t('ProjectChannelScreen.channelArchived')}</p>;
  }

  return (
    <form
      className="tm-chat-composer"
      onSubmit={submit}
      {...(canAttach ? { 'data-dragging': dragging ? 'true' : 'false' } : {})}
      {...dropProps}
    >
      {replyTo !== undefined ? (
        <div className="tm-pane-reply-bar">
          <ReplyQuote
            authorName={replyTo.authorName}
            excerpt={replyMetaFor(replyTo.message).excerpt}
          />
          <button
            type="button"
            className="tm-chat-side__round"
            aria-label={tOr('ChatMessages.cancelReply', 'Cancel reply')}
            onClick={() => {
              onCancelReply?.();
              controlRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
      <label className="tm-visually-hidden" htmlFor={controlId}>
        {label}
      </label>
      <textarea
        id={controlId}
        ref={controlRef}
        className="tm-chat-composer__input"
        rows={parentMessageId === undefined ? 1 : 3}
        maxLength={16000}
        value={draft}
        placeholder={placeholder ?? label}
        onChange={(event) => {
          setDraft(event.target.value);
          if (mentionsOn) {
            mention.sync(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }
        }}
        onKeyDown={onComposerKeyDown}
        {...(mentionsOn ? mention.controlProps : {})}
      />

      {mentionsOn && mention.open ? (
        <MentionPicker
          id={mention.listboxId}
          options={mention.options}
          activeIndex={mention.activeIndex}
          onPick={mention.pick}
          onHover={mention.setActiveIndex}
          query={mention.query}
        />
      ) : null}

      {composed?.kind === 'rich' ? (
        <section className="tm-chat-preview" aria-label={t('ProjectChannelScreen.previewAria')}>
          <h3 className="tm-chat-eyebrow">{t('ProjectChannelScreen.previewHeading')}</h3>
          <RichTextBody document={composed.document} />
        </section>
      ) : null}

      {pendingFiles.length > 0 ? (
        <ul
          className="tm-chat-files tm-pane-composer-files"
          aria-label={tOr('ChatMessages.attachedFiles', 'Files to send')}
        >
          {pendingFiles.map((file, index) => (
            <li key={`${file.name}-${file.size}-${index}`} className="tm-chat-file">
              <span className="tm-chat-file__icon" aria-hidden="true">
                <PhoneIcon name="file" size={16} />
              </span>
              <span className="tm-chat-file__text">
                <span className="tm-chat-file__name">{file.name}</span>
                {send.isPending && sentBytes?.[index] !== undefined ? (
                  <UploadMeter name={file.name} sent={sentBytes[index]} total={file.size} />
                ) : (
                  <span className="tm-chat-file__meta">{formatBytes(file.size)}</span>
                )}
              </span>
              <button
                type="button"
                className="tm-chat-side__round"
                aria-label={tOr('ChatMessages.removeFile', 'Remove {name}').replace(
                  '{name}',
                  file.name,
                )}
                disabled={send.isPending}
                onClick={() => removePendingFile(index)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {fileProblem !== undefined ? (
        <InlineAlert
          tone="warning"
          title={tOr('ChatMessages.attachRefused', 'This file cannot be attached')}
          live
        >
          {fileProblem}
        </InlineAlert>
      ) : null}

      {inadmissible !== undefined ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.formattingCannotSend')} live>
          {inadmissible}
        </InlineAlert>
      ) : null}

      {locationError ? (
        <InlineAlert
          tone="warning"
          title={tOr('ChatMessages.locationUnavailable', 'Location is not available')}
          live
        >
          {tOr(
            'ChatMessages.locationHelp',
            'Allow location access in the browser, then try again.',
          )}
        </InlineAlert>
      ) : null}

      {send.error instanceof FilesNotAttachedError ? (
        // SMALLFIX item 2: the text went out; only a file did not. "Not sent" was untrue here.
        <InlineAlert
          tone="warning"
          title={tOr('ChatMessages.upload.sentWithoutFile', 'Message sent without a file')}
          live
        >
          {describeError(send.error, t, tOr)}
        </InlineAlert>
      ) : send.isError ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.notSent')} live>
          {describeError(send.error, t, tOr)}{' '}
          {send.error instanceof NetworkError ? t('ProjectChannelScreen.textStillHere') : ''}
        </InlineAlert>
      ) : null}

      {sendLocation.isError ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.notSent')} live>
          {describeError(sendLocation.error, t, tOr)}
        </InlineAlert>
      ) : null}

      {channelStyle ? (
        <div className="tm-chat-composer__bar tm-chat-composer__bar--channel">
          <button
            type="button"
            className="tm-chat-side__round"
            aria-label={tOr('ProjectChannelScreen.formattingToggle', 'Formatting')}
            title={tOr('ProjectChannelScreen.formattingToggle', 'Formatting')}
            aria-expanded={toolsOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setToolsOpen((open) => !open)}
          >
            <span aria-hidden="true">+</span>
          </button>
          {toolsOpen ? toolbar : null}
          {attachOn ? (
            <>
              <button
                type="button"
                className="tm-chat-side__round"
                aria-label={
                  canAttach
                    ? tOr('ChatMessages.attachFile', 'Attach a file')
                    : tOr(
                        'ChatMessages.attachNoProject',
                        'Files can only be sent in a project chat',
                      )
                }
                title={
                  canAttach
                    ? tOr('ChatMessages.attachFile', 'Attach a file')
                    : tOr(
                        'ChatMessages.attachNoProject',
                        'Files can only be sent in a project chat',
                      )
                }
                disabled={!canAttach || send.isPending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <PhoneIcon name="paperclip" size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={ATTACHMENT_ACCEPT}
                tabIndex={-1}
                aria-hidden="true"
                onChange={onFilePicked}
              />
            </>
          ) : null}
          {extraButtons}
          <span className="tm-chat-composer__spacer" aria-hidden="true" />
          {voice}
          {mentionsOn ? (
            <MentionButton
              label={tOr('MentionPicker.button', 'Mention someone')}
              onClick={mention.openAtCaret}
            />
          ) : null}
          <button
            type="submit"
            className="tm-chat-side__send"
            aria-label={
              send.isPending ? t('ProjectChannelScreen.sending') : t('ProjectChannelScreen.send')
            }
            title={t('ProjectChannelScreen.send')}
            disabled={(composed === undefined && pendingFiles.length === 0) || send.isPending}
            aria-busy={send.isPending}
          >
            <span className="tm-chat-side__send-arrow" aria-hidden="true">
              →
            </span>
            <PhoneIcon name="send" className="tm-phone-chat__send-icon" />
          </button>
        </div>
      ) : (
        <div className="tm-chat-composer__bar">
          {toolbar}
          <MicButton dictation={dictation} compact />
          <button
            type="submit"
            className="tm-chat-send"
            disabled={composed === undefined || send.isPending}
            aria-busy={send.isPending}
          >
            <span className="tm-chat-send__orb" aria-hidden="true">
              ↑
            </span>
            {send.isPending ? t('ProjectChannelScreen.sending') : t('ProjectChannelScreen.send')}
          </button>
        </div>
      )}
      {channelStyle ? null : <MicNotice dictation={dictation} />}
    </form>
  );
}
