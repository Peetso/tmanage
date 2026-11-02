import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { UnfurlController } from './unfurl.controller.js';
import { UnfurlService } from './unfurl.service.js';

const ORG = 'organization-0000-0000-0000-000000000001';
const ctx = { organizationId: ORG, userId: 'u1' } as unknown as TenantContext;
const owner = {
  userId: 'u1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as Principal;

describe('UnfurlController', () => {
  it('answers a card with a private 5-minute Cache-Control', async () => {
    const service = new UnfurlService({
      resolve: async () => [{ address: '140.82.112.3', family: 4 }],
      transport: async () => ({
        status: 200,
        contentType: 'text/html',
        body: (async function* () {
          yield new TextEncoder().encode('<title>acme</title>');
        })(),
      }),
    });
    const headers: Record<string, string> = {};
    const reply = { header: (name: string, value: string) => (headers[name] = value) };
    const card = await new UnfurlController(service).get(ctx, owner, reply, 'https://github.com/a');
    expect(card.title).toBe('acme');
    expect(headers['Cache-Control']).toBe('private, max-age=300');
  });

  it('answers 400 invalid_url when ?url= is missing', async () => {
    const controller = new UnfurlController(new UnfurlService());
    await expect(controller.get(ctx, owner, { header: () => undefined })).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'url', message: 'invalid_url' }],
    });
  });
});
