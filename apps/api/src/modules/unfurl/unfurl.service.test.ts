import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { UnfurlService } from './unfurl.service.js';
import type { UnfurlFetchResult, UnfurlTransport } from './unfurl.service.js';

/**
 * R20-a unfurl proxy proofs over a stub transport and a stub resolver — no network, no database.
 * Each SSRF rule is proven by the transport never being called.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER = 'organization-0000-0000-0000-000000000002';
const ctx = (organizationId = ORG) =>
  ({ organizationId, userId: 'u1' }) as unknown as TenantContext;

function principal(kind: Principal['kind'] = 'internal', organizationId = ORG): Principal {
  return {
    userId: 'u1',
    organizationId,
    kind,
    role: kind === 'client' ? 'client_member' : 'owner',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

const enc = new TextEncoder();
async function* once(text: string): AsyncIterable<Uint8Array> {
  yield enc.encode(text);
}
const html = (status: number, text: string): UnfurlFetchResult => ({
  status,
  contentType: 'text/html; charset=utf-8',
  body: once(text),
});
const publicResolver = async () => [{ address: '140.82.112.3', family: 4 }];

function service(transport: UnfurlTransport, resolve = publicResolver) {
  return new UnfurlService({ transport, resolve });
}

const GH = 'https://github.com/acme/repo';
const GH_HTML =
  '<meta property="og:title" content="acme/repo"><meta property="og:description" content="Repo">';

describe('UnfurlService', () => {
  it('refuses a host resolving to a private address before any transport call', async () => {
    const transport = vi.fn<UnfurlTransport>();
    const svc = service(transport, async () => [{ address: '10.0.0.5', family: 4 }]);
    await expect(svc.unfurl(ctx(), principal(), GH)).rejects.toMatchObject({
      status: 404,
      details: [{ field: 'url', message: 'unfurl_unavailable' }],
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'http://github.com/a',
    'https://u:p@github.com/a',
    'https://github.com:8443/a',
    'https://evil.figma.com/design/x',
    'https://figma.com.evil.net/design/x',
  ])('answers 422 for %s with no fetch', async (raw) => {
    const transport = vi.fn<UnfurlTransport>();
    await expect(service(transport).unfurl(ctx(), principal(), raw)).rejects.toMatchObject({
      status: 422,
      details: [{ field: 'url', message: 'unfurl_host_not_allowed' }],
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('never follows a 302 and never echoes the upstream body', async () => {
    const transport = vi.fn<UnfurlTransport>(async () => html(302, 'SECRET-UPSTREAM'));
    const error = await service(transport)
      .unfurl(ctx(), principal(), GH)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404 });
    expect(JSON.stringify(error)).not.toContain('SECRET-UPSTREAM');
    expect((error as Error).message).not.toContain('SECRET-UPSTREAM');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('truncates a 2 MB body at 512 KiB and still parses the head', async () => {
    let served = 0;
    async function* big(): AsyncIterable<Uint8Array> {
      yield enc.encode(GH_HTML);
      for (let i = 0; i < 32; i += 1) {
        served += 1;
        yield new Uint8Array(64 * 1024).fill(0x61);
      }
    }
    const svc = service(async () => ({ status: 200, contentType: 'text/html', body: big() }));
    const card = await svc.unfurl(ctx(), principal(), GH);
    expect(card).toMatchObject({ provider: 'github', title: 'acme/repo', description: 'Repo' });
    expect(served).toBeLessThan(32);
  });

  it('maps a timeout to the 404 token', async () => {
    const svc = service(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expect(svc.unfurl(ctx(), principal(), GH)).rejects.toMatchObject({ status: 404 });
  });

  it('serves the second call from the cache', async () => {
    const transport = vi.fn<UnfurlTransport>(async () => html(200, GH_HTML));
    const svc = service(transport);
    await svc.unfurl(ctx(), principal(), GH);
    const again = await svc.unfurl(ctx(), principal(), `${GH}#readme`);
    expect(again.title).toBe('acme/repo');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses the 61st call in the hour for one org while another org passes', async () => {
    const svc = service(async () => html(200, GH_HTML));
    for (let i = 0; i < 60; i += 1) await svc.unfurl(ctx(), principal(), GH);
    await expect(svc.unfurl(ctx(), principal(), GH)).rejects.toMatchObject({
      status: 429,
      details: [{ field: 'url', message: 'unfurl_rate_limited' }],
    });
    await expect(svc.unfurl(ctx(OTHER), principal('internal', OTHER), GH)).resolves.toBeTruthy();
  });

  it('builds a Figma card from oEmbed with an https thumbnail only', async () => {
    const calls: string[] = [];
    const json =
      (thumb: string): UnfurlTransport =>
      async (url) => {
        calls.push(url);
        return {
          status: 200,
          contentType: 'application/json',
          body: once(JSON.stringify({ title: 'Home', thumbnail_url: thumb, provider_name: 'X' })),
        };
      };
    const link = 'https://www.figma.com/design/AbCdEfGhIj12/Home?node-id=1-2';
    const card = await service(json('https://s3.figma.com/t.png')).unfurl(ctx(), principal(), link);
    expect(card).toEqual({
      provider: 'figma',
      url: link,
      title: 'Home',
      description: null,
      thumbnailUrl: 'https://s3.figma.com/t.png',
      openUrl: 'https://www.figma.com/design/AbCdEfGhIj12?node-id=1-2',
    });
    expect(calls[0]).toBe(`https://www.figma.com/api/oembed?url=${encodeURIComponent(link)}`);
    const http = await service(json('http://s3.figma.com/t.png')).unfurl(ctx(), principal(), link);
    expect(http.thumbnailUrl).toBeNull();
  });

  it('builds a GitHub card from the og tags', async () => {
    const card = await service(async () => html(200, GH_HTML)).unfurl(ctx(), principal(), GH);
    expect(card).toEqual({
      provider: 'github',
      url: GH,
      title: 'acme/repo',
      description: 'Repo',
      thumbnailUrl: null,
      openUrl: GH,
    });
  });

  it('answers a private Figma file (oEmbed 404) with the share hint', async () => {
    const svc = service(async () => ({
      status: 404,
      contentType: 'text/plain',
      body: once('nope'),
    }));
    await expect(
      svc.unfurl(ctx(), principal(), 'https://www.figma.com/design/AbCdEfGhIj12/x'),
    ).rejects.toMatchObject({
      status: 404,
      details: [
        { field: 'url', message: 'unfurl_unavailable' },
        { field: 'hint', message: 'ask_designer_to_share' },
      ],
    });
  });

  it('refuses a client principal with 403 before anything else', async () => {
    const transport = vi.fn<UnfurlTransport>();
    await expect(service(transport).unfurl(ctx(), principal('client'), GH)).rejects.toMatchObject({
      status: 403,
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
