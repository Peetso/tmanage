import { describe, expect, it } from 'vitest';
import type { IntegrationAppView } from '../src/lib/api/integration-directory';
import {
  localizedDescribeApp,
  localizedDirectoryTitle,
} from '../src/components/screens/integration-directory-i18n';
import { localizedHours, localizedSinceLabel } from '../src/components/admin/localized-time';

const slack: IntegrationAppView = {
  id: 'slack',
  name: 'Slack',
  category: 'messaging',
  capabilities: ['notify', 'channel-post'],
  connections: [],
};
const arabic: Record<string, string> = {
  'IntegrationDirectoryScreen.titleNothing': 'لا شيء متصل بعد',
  'IntegrationDirectoryScreen.capability.notify': 'يرسل الإشعارات',
  'IntegrationDirectoryScreen.capability.channel-post': 'ينشر في قناة',
  'IntegrationDirectoryScreen.listAnd': ' و',
};
const tr = (key: string, english: string) => arabic[key] ?? english;

describe('C6 admin copy in Arabic', () => {
  it('builds the directory copy from catalog keys, and keeps English unchanged', () => {
    expect(localizedDescribeApp(slack, tr, 'ar')).toBe('يرسل الإشعارات وينشر في قناة');
    expect(localizedDirectoryTitle([slack], tr, 'ar')).toBe('لا شيء متصل بعد');
    expect(localizedDescribeApp(slack, tr, 'en')).toBe(
      'Sends notifications and posts to a channel.',
    );
  });

  it('prints compact times without English units', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(localizedSinceLabel('2026-11-06T19:00:00Z', 'ar', now)).not.toMatch(/[A-Za-z]/);
    expect(localizedHours(24, 'ar')).not.toMatch(/[A-Za-z]/);
    expect(localizedHours(24, 'en')).toBe('24h');
  });
});
