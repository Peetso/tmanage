import { describe, expect, it } from 'vitest';
import { findOpById } from './registry/index.js';
import {
  APPROVAL_TTL_LONG_MS,
  APPROVAL_TTL_SHORT_MS,
  approvalLifetimeMs,
  expiryInWords,
} from './approval-lifetime.js';
import { PENDING_AI_ACTION_TTL_MS, approvalMessage } from '../mcp/pending-actions.js';
import { AI_CARD_TTL_MS } from '../copilot/ai-preview.js';

/**
 * Fix 6 of the live AI test (2026-11-23): an approval of an ordinary write waits 24 hours; one
 * that changes settings or rights, billing, money, HR or removes something waits 30 minutes; the
 * answer says the expiry in words.
 */

const op = (id: string) => {
  const found = findOpById(id);
  if (found === undefined) throw new Error(`no op ${id}`);
  return found;
};

describe('fix 6 · approval lifetime', () => {
  it('gives an ordinary write 24 hours', () => {
    expect(approvalLifetimeMs(op('projects.update'))).toBe(APPROVAL_TTL_LONG_MS);
    expect(approvalLifetimeMs(op('work_item_files.upload_inline'))).toBe(APPROVAL_TTL_LONG_MS);
  });

  it('gives manage, removals and destructive changes 30 minutes', () => {
    for (const id of [
      'copilot.settings.update',
      'projects.delete',
      'quotes.delete',
      'projects.archive',
    ]) {
      expect(approvalLifetimeMs(op(id)), id).toBe(APPROVAL_TTL_SHORT_MS);
    }
  });

  it('keeps the stored upper bound and the in-app card in step with the rule', () => {
    expect(PENDING_AI_ACTION_TTL_MS).toBe(APPROVAL_TTL_LONG_MS);
    expect(AI_CARD_TTL_MS).toBe(APPROVAL_TTL_SHORT_MS);
  });

  it('says the expiry in plain words, in UTC', () => {
    const now = new Date('2026-11-23T14:05:00.000Z');
    expect(expiryInWords(new Date(now.getTime() + APPROVAL_TTL_LONG_MS), now)).toBe(
      'This approval link works for 24 hours, until 24 November 2026 at 14:05 UTC.',
    );
    expect(expiryInWords(new Date(now.getTime() + APPROVAL_TTL_SHORT_MS), now)).toBe(
      'This approval link works for 30 minutes, until 23 November 2026 at 14:35 UTC.',
    );
  });

  it('puts the words into the message the AI relays', () => {
    const now = new Date('2026-11-23T14:05:00.000Z');
    const message = approvalMessage(
      'Rename project',
      'https://x.example/a',
      new Date(now.getTime() + APPROVAL_TTL_SHORT_MS),
      now,
    );
    expect(message).toContain('https://x.example/a');
    expect(message).toContain('works for 30 minutes');
  });
});
