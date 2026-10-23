import { describe, expect, it } from 'vitest';
import { ALLOWED_REACTIONS, isAllowedReaction } from './message-reactions.service.js';

/**
 * A16 (chat basics): the approved Figma's quick reactions are ♥ ✓ ☺ ★. The heart was already
 * allowed; the other three are added to the closed allowlist so the channel's reaction pills and
 * the phone actions sheet can store them. Anything outside the list stays a 400.
 */
describe('message reaction allowlist', () => {
  it('admits the quick reactions the channel draws and still refuses an unknown glyph', () => {
    for (const glyph of ['❤️', '\u{2713}', '\u{263A}', '\u{2605}']) {
      expect(isAllowedReaction(glyph)).toBe(true);
    }
    expect(isAllowedReaction('\u{1F4A9}')).toBe(false);
    expect(new Set(ALLOWED_REACTIONS).size).toBe(ALLOWED_REACTIONS.length);
  });
});
