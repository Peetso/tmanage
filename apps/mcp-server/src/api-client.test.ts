import { describe, expect, it } from 'vitest';
import { ApiError, createHttpApiClient } from './api-client.js';

function fakeFetch(calls: { url: string; init: RequestInit }[], response: Response): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
}

describe('createHttpApiClient', () => {
  it('sends the bearer token and builds the tenant-scoped path', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createHttpApiClient({
      baseUrl: 'https://api.example.com/',
      token: 'tmanage_pat_x',
      orgSlug: 'acme',
      fetch: fakeFetch(calls, new Response(JSON.stringify({ projects: [] }), { status: 200 })),
    });
    await client.listProjects(await client.resolveOrgSlug());
    expect(calls[0]!.url).toBe('https://api.example.com/v1/organizations/acme/projects');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer tmanage_pat_x',
    );
  });

  it('maps a non-2xx response to an ApiError carrying status and code', async () => {
    const client = createHttpApiClient({
      baseUrl: 'https://api.example.com',
      token: 't',
      orgSlug: 'acme',
      fetch: fakeFetch(
        [],
        new Response(JSON.stringify({ code: 'forbidden', message: 'no' }), { status: 403 }),
      ),
    });
    await expect(client.getProject('acme', 'p1')).rejects.toBeInstanceOf(ApiError);
  });
});
