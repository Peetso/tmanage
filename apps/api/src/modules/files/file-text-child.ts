import { extractText, type TextLimits } from './file-text-extractors.js';

/**
 * 62-A0 fallback (1) — the child process entry of {@link ChildTextExtractor}
 * (`file-text-isolation.ts`): one file's text, then exit. It reads nothing but the bytes it is
 * sent, writes nothing, opens no database or network connection; the parent concludes the row.
 *
 * It exits when its parent goes: on `disconnect` here, and through the preloaded parent watchdog
 * (`apps/server/parent-watchdog.mjs`) when the app server runs it.
 */

interface Job {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly limits: TextLimits;
}

process.on('disconnect', () => process.exit(0));

process.once('message', (message: Job) => {
  void extractText(message.bytes, message.mimeType, message.limits)
    .then((outcome) => {
      process.send?.({ outcome }, () => process.exit(0));
    })
    .catch(() => process.exit(1));
});
