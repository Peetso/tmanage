import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { ApiError } from '../../common/http/errors.js';
import { ChannelLinksService, checkChannelUrl } from './channel-links.service.js';
import type { ChannelLinksRepository } from './channel-links.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R15-c — host allow-list, egress refusal, URL never projected or audited, test-post throttle. */
const context = { organizationId: 'org-1', userId: 'user-1' } as unknown as TenantContext;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
const db = {
  read: (_c: unknown, work: (r: never) => unknown) => work({} as never),
  transaction: (_c: unknown, work: (r: never) => unknown) => work({} as never),
} as unknown as TenantDatabase;

function harness(address = '34.1.2.3', lastTest: Date | null = null) {
  const audits: unknown[] = [];
  let stored: Record<string, unknown> = {};
  const repo = {
    findConnection: () => Promise.resolve({ id: 'conn-1' }),
    findDuplicate: () => Promise.resolve(null),
    insert: (_r: never, _c: never, input: Record<string, unknown>) => {
      stored = {
        ...input,
        externalChannelLabel: input['label'] ?? null,
        eventsJson: JSON.stringify(input['events']),
        status: 'active',
        failureStreak: 0,
        createdAt: NOW,
      };
      return Promise.resolve(stored);
    },
    findById: () => Promise.resolve({ ...stored, id: 'l-1', status: 'active', locale: 'en' }),
    lastTestPostAt: () => Promise.resolve(lastTest),
    stageTestPost: () => Promise.resolve('p-1'),
  } as unknown as ChannelLinksRepository;
  const service = new ChannelLinksService(db, repo, {
    cipher: createFieldCipher(parseFieldCipherKeys(`1:${'A'.repeat(43)}=`)),
    audit: {
      append: (_r: never, _c: never, input: unknown) => (audits.push(input), Promise.resolve({})),
    } as never,
    egress: { ownHosts: [], resolve: () => Promise.resolve([{ address, family: 4 }]) },
    now: () => NOW,
  });
  return { service, audits };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: unknown) => (e instanceof ApiError ? e.status : -1),
  );

describe('channel links (R15-c)', () => {
  it('allows only each kind’s incoming-webhook hosts over https', () => {
    expect(checkChannelUrl('slack', SLACK).ok).toBe(true);
    expect(checkChannelUrl('slack', 'https://evil.example/services/x').ok).toBe(false);
    expect(checkChannelUrl('slack', 'http://hooks.slack.com/services/x').ok).toBe(false);
    expect(checkChannelUrl('teams', 'https://acme.webhook.office.com/webhookb2/x').ok).toBe(true);
    expect(checkChannelUrl('teams', 'https://prod-1.westus.logic.azure.com/workflows/x').ok).toBe(
      true,
    );
    expect(checkChannelUrl('teams', SLACK).ok).toBe(false);
  });

  it('accepts the classic Teams host outlook.office.com exactly, never a look-alike (R46)', () => {
    expect(
      checkChannelUrl('teams', 'https://outlook.office.com/webhook/abc/IncomingWebhook/x').ok,
    ).toBe(true);
    expect(checkChannelUrl('teams', 'https://outlook.office.com.evil.example/webhook/x').ok).toBe(
      false,
    );
    expect(checkChannelUrl('teams', 'https://evil-outlook.office.com/webhook/x').ok).toBe(false);
    expect(checkChannelUrl('slack', 'https://outlook.office.com/webhook/x').ok).toBe(false);
    expect(
      checkChannelUrl('teams', 'https://hooks.slack.com.webhook.office.com.evil.io/x').ok,
    ).toBe(false);
  });

  it('refuses a URL that resolves to a private address', async () => {
    const body = { webhookUrl: SLACK, events: ['work.created'] };
    expect(await status(harness('10.0.0.5').service.create(context, 'slack', body))).toBe(400);
  });

  it('never puts the URL in the projection or the audit row', async () => {
    const h = harness();
    const view = await h.service.create(context, 'slack', {
      webhookUrl: SLACK,
      events: ['work.created'],
      locale: 'ar',
    });
    expect(view.urlHost).toBe('hooks.slack.com');
    expect(JSON.stringify([view, h.audits])).not.toContain('XXXXSECRET');
  });

  it('FIX5: a bot link keeps channel and token encrypted, shows only the API host', async () => {
    const h = harness();
    const view = await h.service.createBotLink(
      context,
      { provider: 'slack', channelId: 'C0GENERAL', botToken: 'xoxb-SECRETBOT' },
      { label: '#general' },
    );
    expect(view.urlHost).toBe('slack.com');
    expect(view.label).toBe('#general');
    expect(view.events.length).toBeGreaterThan(0);
    expect(JSON.stringify([view, h.audits])).not.toContain('SECRETBOT');
  });

  it('throttles test posts to one a minute per link', async () => {
    expect(
      await status(
        harness('34.1.2.3', new Date(NOW.getTime() - 30_000)).service.test(context, 'l-1'),
      ),
    ).toBe(429);
    expect(
      await status(
        harness('34.1.2.3', new Date(NOW.getTime() - 61_000)).service.test(context, 'l-1'),
      ),
    ).toBe(0);
  });
});
