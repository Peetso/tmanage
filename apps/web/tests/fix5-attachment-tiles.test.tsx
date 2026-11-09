import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentBubbles } from '../src/components/chat/media/AttachmentBubbles';
import type { MessageAttachmentSummary } from '../src/lib/api/message-attachments';

/**
 * FIX5 item 4 (live check fd145807, B-N4). Three photos left an empty fourth grid cell that
 * showed the dark bubble through, which read as a "black PSD tile"; a photo the browser cannot
 * draw now shows its file type instead of an empty box, and a PSD is a file card, never a tile.
 */

const file = (name: string): MessageAttachmentSummary =>
  ({
    fileAssetId: `fa-${name}`,
    name,
    sizeBytes: 10,
    scanStatus: 'not_scanned',
  }) as MessageAttachmentSummary;

function draw(files: readonly MessageAttachmentSummary[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AttachmentBubbles
        organizationSlug="qa"
        organizationName="QA"
        conversationId="c-1"
        messageId="m-1"
        attachments={files}
      />
    </QueryClientProvider>,
  );
}

describe('FIX5 item 4: the photo grid and the PSD card', () => {
  it('lays three photos out as three tiles (data-count 3), a PSD as a file card', () => {
    const { container } = draw([
      file('moodboard.png'),
      file('site-photo.jpg'),
      file('wordmark.svg'),
      file('template.psd'),
    ]);
    const grid = container.querySelector('.r7-media__grid') as HTMLElement;
    expect(grid.dataset['count']).toBe('3');
    expect(grid.querySelectorAll('.r7-media__tile')).toHaveLength(3);
    expect(container.querySelector('.r7-media__doc')?.textContent).toMatch(/template\.psd/u);
  });

  it('shows the file type when a photo cannot be drawn', () => {
    const { container } = draw([file('broken.png')]);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.r7-media__fallback')?.textContent).toBe('PNG');
  });
});
