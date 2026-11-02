import { describe, expect, it } from 'vitest';
import { channelKindFor } from './channel-notices.js';

describe('channel notice staging filter (R15-c)', () => {
  const done = { workItemId: 'w-1', projectId: 'p-1', toState: 'done' };
  const link = (project_id: string | null, events: string[]) => ({
    id: 'l-1',
    events_json: JSON.stringify(events),
    project_id,
    locale: 'en',
  });

  it('takes org-wide and same-project links, prefers the filtered kind, skips other projects', () => {
    expect(
      channelKindFor(link(null, ['work.updated', 'work.completed']), 'work_item.updated.v1', done),
    ).toBe('work.completed');
    expect(channelKindFor(link('p-1', ['work.updated']), 'work_item.updated.v1', done)).toBe(
      'work.updated',
    );
    expect(channelKindFor(link('p-2', ['work.updated']), 'work_item.updated.v1', done)).toBeNull();
    expect(
      channelKindFor(link(null, ['meeting.scheduled']), 'work_item.updated.v1', done),
    ).toBeNull();
  });
});
