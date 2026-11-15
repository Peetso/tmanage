import type { MessageSummary } from './api/conversations';

function isPageList(data: unknown): data is { readonly pages: readonly unknown[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { readonly pages?: unknown }).pages)
  );
}

/**
 * ACCOUNT item 2 (live persona test 2026-11-15): whether a cached transcript already holds the
 * message a send attempt made. A send can time out in the browser after the API stored it; the
 * stored message carries the attempt's `clientGeneratedId`, so finding it here means the message
 * went out and "Not sent" would be untrue. Reads both shapes a transcript is cached in: one page
 * of messages, or the page list of an infinite query.
 */
export function transcriptHoldsAttempt(data: unknown, clientGeneratedId: string): boolean {
  const pages = isPageList(data) ? data.pages : [data];
  return pages.some(
    (page) =>
      Array.isArray(page) &&
      (page as readonly Partial<MessageSummary>[]).some(
        (message) => message.clientGeneratedId === clientGeneratedId,
      ),
  );
}
