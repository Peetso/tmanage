import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentBubbles } from '../src/components/chat/media/AttachmentBubbles';
import { ApiClient } from '../src/lib/api/client';
import type { MessageAttachmentSummary } from '../src/lib/api/message-attachments';

/**
 * B-N1 (live check fd145807): a viewer opened from a chat message was drawn inside the dark own
 * bubble and inherited its white ink, so XLSX/CSV cells, the file name and the zoom label were
 * white on white. The viewer now lives outside the bubble (a portal on `document.body`), and a
 * click inside it never reaches the bubble's own handlers.
 */

function client(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

const sheet: MessageAttachmentSummary = {
  fileAssetId: 'file-1',
  name: 'calendar.xlsx',
  sizeBytes: 2048,
  scanStatus: 'not_scanned',
} as MessageAttachmentSummary;

describe.each([
  ['sender', 'true'],
  ['receiver', 'false'],
])('chat media viewer from the %s side', (_side, own) => {
  it('opens outside the message bubble, so it never takes the bubble ink', () => {
    const onBubbleClick = vi.fn();
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="tm-pane-bubble" data-own={own} onClick={onBubbleClick}>
          <AttachmentBubbles
            client={client()}
            organizationSlug="northstar"
            organizationName="Northstar"
            conversationId="c-1"
            messageId="m-1"
            attachments={[sheet]}
          />
        </div>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /calendar\.xlsx/u }));
    onBubbleClick.mockClear();
    const viewer = screen.getByTestId('chat-media-viewer');
    expect(viewer.parentElement).toBe(document.body);
    expect(viewer.closest('.tm-pane-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onBubbleClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('chat-media-viewer')).toBeNull();
    // Escape from inside the viewer closes it too (FIX5 walkthrough: it did not).
    fireEvent.click(screen.getByRole('button', { name: /calendar\.xlsx/u }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByTestId('chat-media-viewer')).toBeNull();
  });
});
