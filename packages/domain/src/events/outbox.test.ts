import { describe, expect, it } from 'vitest';
import { MAX_MENTIONS_PER_TEXT, extractMentionedUserIds } from './outbox.js';

const MONA = '0198f100-0000-7000-8000-0000000000a2';
const OMAR = '0198F100-0000-7000-8000-0000000000A3';

describe('extractMentionedUserIds (CQ-12)', () => {
  it('reads @<userId> tokens once each, lower-cased, and ignores a typed name', () => {
    expect(extractMentionedUserIds(`@${MONA} hi @Mona, @${OMAR} and @${MONA} again`)).toEqual([
      MONA,
      OMAR.toLowerCase(),
    ]);
  });

  it('caps a wall of ids', () => {
    const ids = Array.from(
      { length: MAX_MENTIONS_PER_TEXT + 5 },
      (_, i) => `@0198f100-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(extractMentionedUserIds(ids.join(' '))).toHaveLength(MAX_MENTIONS_PER_TEXT);
  });
});
