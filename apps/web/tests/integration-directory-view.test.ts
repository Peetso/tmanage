import { describe, expect, it } from 'vitest';
import type { IntegrationAppView } from '../src/lib/api/integration-directory';
import {
  describeApp,
  describeAppLine,
  directoryTitle,
  relativeAgo,
} from '../src/components/screens/integration-directory-view';
import { describeRunDetail } from '../src/components/screens/run-detail-view';

function app(id: string, statuses: readonly ('connected' | 'pending')[]): IntegrationAppView {
  return {
    id,
    name: id,
    category: 'messaging',
    capabilities: ['notify', 'channel-post'],
    connections: statuses.map((status, index) => ({
      id: `${id}-${index}`,
      appId: id,
      label: 'x',
      status,
      config: {},
      createdAt: '2026-10-18T00:00:00.000Z',
    })),
  };
}

describe('INT-01 view helpers', () => {
  it('counts apps, not connections, and keeps a live app out of the pending count', () => {
    expect(directoryTitle([app('a', ['connected', 'pending']), app('b', ['pending'])])).toBe(
      'One connected, one pending',
    );
    expect(directoryTitle([app('a', [])])).toBe('Nothing connected yet');
  });

  it('describes capabilities in plain words and keeps proper nouns in the row line', () => {
    expect(describeApp(app('a', []))).toBe('Sends notifications and posts to a channel.');
    const zapier = { ...app('z', []), capabilities: ['trigger'] };
    expect(describeAppLine(zapier)).toBe('starts flows from TManage events');
  });

  it('writes the foot time the way INT-01 does', () => {
    const now = Date.parse('2026-10-18T12:00:00.000Z');
    expect(relativeAgo('2026-10-18T11:56:00.000Z', now)).toBe('4 min ago');
    expect(relativeAgo('2026-10-17T11:00:00.000Z', now)).toBe('1 day ago');
  });
});

describe('AUT-04 run detail lines', () => {
  it('hides ids and turns a known reason into a sentence, never raw JSON', () => {
    const lines = describeRunDetail({
      templateId: '01a14d31',
      triggerKind: 'document_published',
      outcome: 'not_run',
      reason: 'external_action_not_supported_in_app',
    });
    expect(lines.map((l) => l.label)).toEqual(['Trigger', 'Outcome', 'Why']);
    expect(lines[0]!.value).toBe('Document published');
    expect(lines[2]!.value).toMatch(/outside TManage/);
  });
});
