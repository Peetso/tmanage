import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentBubbles } from '../src/components/chat/media/AttachmentBubbles';
import type { MessageAttachmentSummary } from '../src/lib/api/message-attachments';

/**
 * FIX5 item 4 (live check fd145807, B-N4). Three photos left an empty fourth grid cell that
 * showed the dark bubble through, which read as a "black PSD tile"; a photo the browser cannot
 * draw now shows its file type instead of an empty box. FIX6 item 5: a PSD is a tile again, drawn
 * from its preview thumbnail (never its own bytes), with its file type until that is ready.
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
  it('lays three photos out as three tiles (data-count 3)', () => {
    const { container } = draw([
      file('moodboard.png'),
      file('site-photo.jpg'),
      file('wordmark.svg'),
    ]);
    const grid = container.querySelector('.r7-media__grid') as HTMLElement;
    expect(grid.dataset['count']).toBe('3');
    expect(grid.querySelectorAll('.r7-media__tile')).toHaveLength(3);
  });

  it('draws a PSD as a tile from its thumbnail, never from its own bytes (FIX6 item 5)', () => {
    const { container } = draw([file('template.psd')]);
    const tile = container.querySelector('.r7-media__tile') as HTMLElement;
    expect(tile.getAttribute('aria-label')).toMatch(/template\.psd/u);
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.querySelector('.r7-media__fallback')?.textContent).toBe('PSD');
    expect(container.querySelector('.r7-media__doc')).toBeNull();
  });

  it('shows the file type when a photo cannot be drawn', () => {
    const { container } = draw([file('broken.png')]);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.r7-media__fallback')?.textContent).toBe('PNG');
  });
});
