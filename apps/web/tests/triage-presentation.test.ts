import { describe, expect, it } from 'vitest';
import { previewClientSentence } from '../src/lib/triage-presentation';

/**
 * REQ-09 — the sentence the client reads when a request is accepted must not carry a double full
 * stop. A manager who ends the scope with "." used to produce "…three plans..".
 */
describe('previewClientSentence (REQ-09)', () => {
  it('does not double the full stop when the scope already ends in one', () => {
    const sentence = previewClientSentence('Redesign the three plans.', { kind: 'unscheduled' });
    expect(sentence).not.toContain('..');
    expect(sentence).toContain('Redesign the three plans.');
  });

  it('adds a single full stop when the scope has none', () => {
    const sentence = previewClientSentence('Redesign the three plans', {
      kind: 'committed',
      day: '2026-09-10',
    });
    expect(sentence).not.toContain('..');
    expect(sentence).toContain('Redesign the three plans.');
  });
});
