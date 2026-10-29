import { describe, expect, it } from 'vitest';
import { clampOccurredAt, hashActor, parseEventBatch } from './product-events.registry.js';

const now = new Date('2026-10-29T12:00:00.000Z');

describe('55-21 product event registry', () => {
  it('drops unknown events and content properties such as message_text (PRIV-06)', () => {
    const batch = parseEventBatch(
      {
        events: [
          { name: 'help_feedback_v1', properties: { helpful: true, message_text: 'hi' } },
          { name: 'made_up_v1' },
        ],
      },
      now,
    );
    expect(batch.accepted.map((event) => event.properties)).toEqual([{ helpful: true }]);
    expect([batch.droppedEvents, batch.droppedProperties]).toEqual([1, 1]);
  });

  it('clamps the client instant to five minutes of server time', () => {
    expect(clampOccurredAt('2030-01-01T00:00:00Z', now).toISOString()).toBe(
      '2026-10-29T12:05:00.000Z',
    );
  });

  it('hashes the actor per quarter, never the raw id', () => {
    const hash = hashActor('s'.repeat(16), 'membership-1', now);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(
      hashActor('s'.repeat(16), 'membership-1', new Date('2027-01-02T00:00:00Z')),
    );
  });
});
