import { describe, expect, it } from 'vitest';
import { deriveReceipts } from './message-receipts.repository.js';
import { advances } from './read-state.service.js';

const at = new Date('2026-11-01T10:00:00.000Z');
const row = (userId: string, readSequence: number | null, deliveredSequence: number | null) => ({
  userId,
  displayName: userId,
  readSequence,
  deliveredSequence,
  readAt: at,
  updatedAt: at,
});

describe('R7 receipts and read-state', () => {
  it('derives a group of 3: read implies delivered, the author is nobody’s recipient', () => {
    const rows = [row('author', 9, 9), row('sara', 5, 5), row('omar', 4, 6), row('lina', 2, 3)];
    const view = deriveReceipts(rows, 5, 'author');
    expect(view.readBy.map((r) => r.userId)).toEqual(['sara']);
    expect(view.deliveredTo.map((r) => r.userId)).toEqual(['sara', 'omar']);
  });

  it('a position only ever moves forward', () => {
    expect(advances(null, 1)).toBe(true);
    expect(advances(4, 5)).toBe(true);
    expect(advances(5, 5)).toBe(false);
    expect(advances(7, 3)).toBe(false);
  });
});
