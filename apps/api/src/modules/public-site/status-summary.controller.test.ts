import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { StatusRepository } from './status.repository.js';
import { PublicStatusSummaryController, sanitiseStatusLink } from './status-summary.controller.js';

describe('GET /v1/public/site/status/summary', () => {
  it('answers the banner state and the link, cached, with no incident text', async () => {
    let reads = 0;
    const database = {
      identityRead: (_o: unknown, work: (r: unknown) => unknown) => work({}),
    } as unknown as TenantDatabase;
    const row = {
      id: 'i1',
      component: 'API',
      status: 'investigating',
      title: 'secret title',
      body: 'b',
      startedAt: new Date(),
      resolvedAt: null,
      published: true,
      createdAt: new Date(),
    };
    const repository = {
      listPublishedIncidents: () => (reads++, Promise.resolve([row])),
    } as unknown as StatusRepository;
    const controller = new PublicStatusSummaryController(
      database,
      repository,
      'https://stats.uptimerobot.com/abc',
    );
    const reply = { header: () => undefined };
    const first = await controller.summary(reply);
    await controller.summary(reply);
    expect(first).toMatchObject({
      overall: 'investigating',
      activeIncidents: 1,
      liveStatusUrl: 'https://stats.uptimerobot.com/abc',
    });
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(reads).toBe(1);
  });

  it('drops a link that is not plain https', () => {
    expect(sanitiseStatusLink('http://x.io')).toBeNull();
    expect(sanitiseStatusLink('https://u:p@x.io')).toBeNull();
  });
});
