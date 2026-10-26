import { describe, expect, it } from 'vitest';
import type { ConnectedApp } from '../src/lib/api/connected-apps';
import { assistantChoices, decideLaunch } from '../src/components/ai-panel/assistant-sites';

function app(clientName: string, lastUsedAt: string | null, mine = false): ConnectedApp {
  return {
    id: `${clientName}-${lastUsedAt}`,
    clientName,
    verified: true,
    scopes: [],
    memberName: 'Maya Hassan',
    mine,
    connectedAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt,
  };
}

/** Figma 400:5399: what "Let AI do the job" does with the person's Connected apps. */
describe('AI panel chooser decision', () => {
  it('lists one row per known assistant, newest use first, the own connection winning', () => {
    const choices = assistantChoices([
      app('Cursor', '2026-10-20T00:00:00.000Z'),
      app('Claude', '2026-10-25T00:00:00.000Z'),
      app('Claude', null, true),
      app('Field notes bot', '2026-10-26T00:00:00.000Z'),
    ]);
    expect(choices.map((choice) => choice.site.key)).toEqual(['cursor', 'claude']);
    expect(choices[1]?.connection.mine).toBe(true);
  });

  it('shows the empty state, opens a single one straight, or asks among several', () => {
    const one = assistantChoices([app('ChatGPT', null)]);
    const two = assistantChoices([app('ChatGPT', null), app('Claude', null)]);
    expect(decideLaunch([], null)).toEqual({ kind: 'empty' });
    expect(decideLaunch(one, null)).toMatchObject({ kind: 'open', site: { key: 'chatgpt' } });
    expect(decideLaunch(two, null)).toMatchObject({ kind: 'choose' });
  });

  it('opens the remembered assistant straight away, ignoring an unknown remembered key', () => {
    const two = assistantChoices([app('ChatGPT', null), app('Claude', null)]);
    expect(decideLaunch(two, 'claude')).toMatchObject({ kind: 'open', site: { key: 'claude' } });
    expect(decideLaunch(two, 'evil')).toMatchObject({ kind: 'choose' });
  });
});
