'use client';

import { useCallback } from 'react';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  MAX_ATTACHMENT_BYTES,
  UploadFailedError,
  attachmentMimeType,
  formatBytes,
} from '../../lib/api/uploads';
import type { UploadBlockedReason } from '../../lib/api/uploads';
import { useTOr } from '../../lib/i18n/use-t-or';
import { uploadRefusal } from '../chat/pane/Composer';

/**
 * QA-FIX S5, M8, S8, S9 (2026-11-20): one wording for what happened to an upload, for every
 * surface that shows an upload row (Files, the portal).
 *
 * - Refused before a byte moved (too big, a type TManage does not take): said at once, with the
 *   limit or the accepted types (NN/g heuristic 9, "help users recognize, diagnose, and recover
 *   from errors": the message names the problem and a way forward).
 * - Refused by the server at session time (the `file_not_allowed` reason token) or by the checks
 *   after the bytes arrived (`blockedReason`): each cause in its own words, so a type refusal is
 *   never blamed on the virus scan (S9), and a virus finding is said as one (S4).
 * - Anything else stays a failure the person may retry.
 */

/** Reasons that are about the file's type: the message lists what is accepted. */
const TYPE_REASONS: ReadonlySet<string> = new Set([
  'type_not_allowed',
  'archive_off',
  'channel_forbids',
  'executable',
  'double_extension',
]);

const REFUSED_ENGLISH: Readonly<Record<string, string>> = {
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

const BLOCKED_ENGLISH: Readonly<Record<UploadBlockedReason, string>> = {
  malware: '“{name}” was blocked by the virus check and was not added.',
  file_type:
    '“{name}” was refused: its contents are not the file type its name says. This was not a virus finding. Save it in its real format and upload it again.',
  content:
    '“{name}” was refused because of something inside it, such as macros or a locked archive. This was not a virus finding.',
  damaged: '“{name}” changed while it was uploading. Upload it again.',
};

const ACCEPTED_ENGLISH =
  'Accepted: PDF, images, Photoshop, Illustrator, video, audio, Word, Excel, PowerPoint, ZIP, text, CSV, Markdown, code and CAD files.';

/** What the browser can tell before sending: `null` when the file may be sent. */
export function preUploadProblem(file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): 'too_large' | 'empty' | 'type_not_allowed' | null {
  if (file.size < 1) return 'empty';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'too_large';
  return attachmentMimeType(file) === null ? 'type_not_allowed' : null;
}

export type UploadOutcome = string | null | { readonly blocked: string };

export function useUploadOutcome(): {
  readonly describe: (error: unknown, file: File) => UploadOutcome;
  readonly preCheck: (file: File) => string | null;
} {
  const tOr = useTOr();

  const accepted = useCallback(() => tOr('UploadOutcome.accepted', ACCEPTED_ENGLISH), [tOr]);

  const refusal = useCallback(
    (reason: string, name: string, entry: string | null) => {
      const key = Object.hasOwn(REFUSED_ENGLISH, reason) ? reason : 'type_not_allowed';
      const sentence = tOr(`ChatMessages.refused.${key}`, REFUSED_ENGLISH[key] as string)
        .replace('{name}', name)
        .replace('{entry}', entry ?? '…');
      return TYPE_REASONS.has(key) ? `${sentence} ${accepted()}` : sentence;
    },
    [accepted, tOr],
  );

  const preCheck = useCallback(
    (file: File): string | null => {
      const problem = preUploadProblem(file);
      if (problem === null) return null;
      if (problem === 'too_large') {
        return tOr(
          'UploadOutcome.tooLarge',
          '“{name}” is larger than {size}, the most one file can be. Make it smaller or split it, then try again.',
        )
          .replace('{name}', file.name)
          .replace('{size}', formatBytes(MAX_ATTACHMENT_BYTES));
      }
      if (problem === 'empty') {
        return tOr('UploadOutcome.empty', '“{name}” is empty.').replace('{name}', file.name);
      }
      return refusal('type_not_allowed', file.name, null);
    },
    [refusal, tOr],
  );

  const describe = useCallback(
    (error: unknown, file: File): UploadOutcome => {
      if (error instanceof UploadFailedError && error.reason === 'rejected') {
        const reason = error.blockedReason;
        if (reason !== null && Object.hasOwn(BLOCKED_ENGLISH, reason)) {
          return {
            blocked: tOr(`UploadOutcome.blocked.${reason}`, BLOCKED_ENGLISH[reason]).replace(
              '{name}',
              file.name,
            ),
          };
        }
        const refused = uploadRefusal(error);
        if (refused !== null) return { blocked: refusal(refused.reason, file.name, refused.entry) };
        return {
          blocked: tOr(
            'UploadOutcome.blocked.unknown',
            '“{name}” did not pass the safety check and was not added.',
          ).replace('{name}', file.name),
        };
      }
      const refused = uploadRefusal(error);
      if (refused !== null) {
        if (refused.reason === 'too_large') {
          return {
            blocked: tOr(
              'UploadOutcome.tooLargeForWorkspace',
              '“{name}” is larger than this workspace allows.',
            ).replace('{name}', file.name),
          };
        }
        return { blocked: refusal(refused.reason, file.name, refused.entry) };
      }
      if (error instanceof ApiRequestError && error.fieldErrors().has('sizeBytes')) {
        return {
          blocked: tOr(
            'UploadOutcome.tooLarge',
            '“{name}” is larger than {size}, the most one file can be. Make it smaller or split it, then try again.',
          )
            .replace('{name}', file.name)
            .replace('{size}', formatBytes(MAX_ATTACHMENT_BYTES)),
        };
      }
      if (error instanceof NetworkError) return null;
      if (error instanceof Error) return error.message;
      return null;
    },
    [refusal, tOr],
  );

  return { describe, preCheck };
}
