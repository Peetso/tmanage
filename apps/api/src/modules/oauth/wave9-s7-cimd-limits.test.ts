import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import {
  CIMD_MAX_CONCURRENT,
  CIMD_MAX_PER_MINUTE_PER_HOST,
  CimdError,
  CimdFetcher,
} from './cimd-fetcher.js';

/**
 * Wave 9 S7 — audit NV07. The anonymous `/oauth/authorize` path must not turn every request into
 * an outbound fetch: outcomes are cached (good and bad), concurrent requests share one fetch,
 * fetches are capped (429) and each one has a total deadline.
 */

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];

function documentFor(url: string): string {
  return JSON.stringify({
    client_id: url,
    client_name: 'Dummy client',
    redirect_uris: ['https://client.example.test/callback'],
  });
}

describe('NV07 — CIMD fetch cache, caps and deadline', () => {
  it('50 authorize requests for one client id make exactly one fetch', async () => {
    const get = vi.fn(async (url: URL) => documentFor(url.toString()));
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get });
    const id = 'https://client.example.test/oauth/metadata.json';
    const results = await Promise.all(Array.from({ length: 50 }, () => fetcher.fetchMetadata(id)));
    expect(results.every((r) => r.clientId === id)).toBe(true);
    await fetcher.fetchMetadata(id);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a failure is cached too: repeated bad ids do not refetch', async () => {
    const get = vi.fn(async () => 'not json');
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get });
    const id = 'https://client.example.test/broken';
    for (let i = 0; i < 10; i += 1) {
      await expect(fetcher.fetchMetadata(id)).rejects.toBeInstanceOf(CimdError);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('the cache expires, so a fixed document is picked up later', async () => {
    let now = 1_000_000;
    const get = vi.fn(async (url: URL) => documentFor(url.toString()));
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get, now: () => now });
    const id = 'https://client.example.test/m';
    await fetcher.fetchMetadata(id);
    now += 11 * 60 * 1000;
    await fetcher.fetchMetadata(id);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a slow server is aborted at the total deadline', async () => {
    let aborted = false;
    const get = vi.fn(
      (_url: URL, _pinned: unknown, signal: AbortSignal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get, deadlineMs: 50 });
    const started = Date.now();
    await expect(fetcher.fetchMetadata('https://slow.example.test/x')).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
  });

  it('slow DNS is bounded by the same deadline', async () => {
    const fetcher = new CimdFetcher({
      resolve: () => new Promise(() => {}),
      get: vi.fn(),
      deadlineMs: 50,
    });
    await expect(fetcher.fetchMetadata('https://dns.example.test/x')).rejects.toThrow(/deadline/);
  });

  it('varying the path on one host hits the per-host rate cap with 429, no fetch', async () => {
    const get = vi.fn(async (url: URL) => documentFor(url.toString()));
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get });
    for (let i = 0; i < CIMD_MAX_PER_MINUTE_PER_HOST; i += 1) {
      await fetcher.fetchMetadata(`https://spray.example.test/${i}`);
    }
    const refused = fetcher.fetchMetadata('https://spray.example.test/over');
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 429 });
    expect(get).toHaveBeenCalledTimes(CIMD_MAX_PER_MINUTE_PER_HOST);
  });

  it('the global concurrency cap refuses with 429 while fetches are in flight', async () => {
    const release: Array<() => void> = [];
    const get = vi.fn(
      (url: URL) =>
        new Promise<string>((resolve) => release.push(() => resolve(documentFor(url.toString())))),
    );
    const fetcher = new CimdFetcher({ resolve: async () => PUBLIC_ADDRESS, get });
    const inFlight = Array.from({ length: CIMD_MAX_CONCURRENT }, (_, i) =>
      fetcher.fetchMetadata(`https://host${i}.example.test/m`),
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(CIMD_MAX_CONCURRENT));
    await expect(fetcher.fetchMetadata('https://extra.example.test/m')).rejects.toMatchObject({
      status: 429,
    });
    release.forEach((r) => r());
    await Promise.all(inFlight);
  });

  it('keeps the SSRF refusal: a private address is never fetched', async () => {
    const get = vi.fn();
    const fetcher = new CimdFetcher({
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
      get,
    });
    await expect(fetcher.fetchMetadata('https://internal.example.test/m')).rejects.toBeInstanceOf(
      CimdError,
    );
    expect(get).not.toHaveBeenCalled();
  });
});
