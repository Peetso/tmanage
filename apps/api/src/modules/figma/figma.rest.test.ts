import { describe, expect, it } from 'vitest';
import {
  FigmaAuthError,
  FigmaRateLimitError,
  FigmaRestClient,
  FigmaUnavailableError,
  figmaEmbedUrl,
  figmaOpenUrl,
  isAllowedRenderUrl,
  normaliseNodeId,
  parseFigmaUrl,
  snapshotScale,
  type FigmaResponse,
  type FigmaTransport,
} from './figma.rest.js';

/** R4 slice 13 — the Figma URL parser and the REST client against a fake transport. */

const KEY = 'ZdUCRiqBiT7s3u08HA28RO';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FigmaResponse {
  return {
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    json: async () => body,
    bytes: async () => (body instanceof Uint8Array ? body : new Uint8Array()),
  };
}

function transport(
  answer: (url: string) => FigmaResponse,
): FigmaTransport & { calls: { url: string; headers: Readonly<Record<string, string>> }[] } {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const fn = (async (url: string, headers: Readonly<Record<string, string>>) => {
    calls.push({ url, headers });
    return answer(url);
  }) as FigmaTransport & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('parseFigmaUrl', () => {
  it('reads a design link with the browser spelling of node-id', () => {
    const parsed = parseFigmaUrl(`https://www.figma.com/design/${KEY}/Atlas?node-id=466-29543&t=x`);
    expect(parsed).toEqual({
      fileKey: KEY,
      nodeId: '466:29543',
      url: `https://www.figma.com/design/${KEY}/Atlas?node-id=466-29543`,
    });
  });

  it('reads file and proto links, and a branch names the branch key', () => {
    expect(parseFigmaUrl(`https://figma.com/file/${KEY}/X?node-id=1%3A2`)?.nodeId).toBe('1:2');
    expect(parseFigmaUrl(`https://www.figma.com/proto/${KEY}/X`)?.nodeId).toBeNull();
    expect(
      parseFigmaUrl(`https://www.figma.com/design/${KEY}/branch/BRANCHKEY12345/X`)?.fileKey,
    ).toBe('BRANCHKEY12345');
  });

  it('refuses anything that is not a Figma file link', () => {
    expect(parseFigmaUrl(`http://www.figma.com/design/${KEY}/X`)).toBeNull();
    expect(parseFigmaUrl(`https://evil.example/design/${KEY}/X`)).toBeNull();
    expect(parseFigmaUrl(`https://www.figma.com.evil.example/design/${KEY}/X`)).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/community/file/123')).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/design/../X')).toBeNull();
    expect(parseFigmaUrl('not a url')).toBeNull();
    expect(parseFigmaUrl(42)).toBeNull();
  });

  it('drops a node id that is not one', () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/X?node-id=abc`)?.nodeId).toBeNull();
    expect(normaliseNodeId('I12:3;4:5')).toBe('I12:3;4:5');
    expect(normaliseNodeId('12-34')).toBe('12:34');
    expect(normaliseNodeId('<script>')).toBeNull();
  });

  it('builds the embed and open addresses', () => {
    expect(figmaEmbedUrl(KEY, '1:2')).toBe(
      `https://embed.figma.com/design/${KEY}?node-id=1-2&embed-host=tmanage`,
    );
    expect(figmaOpenUrl(KEY, null)).toBe(`https://www.figma.com/design/${KEY}`);
  });
});

describe('FigmaRestClient', () => {
  it('sends the token in X-Figma-Token and reads the handle', async () => {
    const fake = transport(() => respond(200, { handle: 'lina', email: 'l@x' }));
    const client = new FigmaRestClient(fake, 'https://api.figma.test/');
    await expect(client.me('figd_token')).resolves.toEqual({ handle: 'lina' });
    expect(fake.calls[0]).toEqual({
      url: 'https://api.figma.test/v1/me',
      headers: { 'X-Figma-Token': 'figd_token' },
    });
  });

  it('maps refusals: 403 → auth, 429 → rate limit with Retry-After, 500 → unavailable', async () => {
    await expect(
      new FigmaRestClient(transport(() => respond(403, {}))).me('t'),
    ).rejects.toBeInstanceOf(FigmaAuthError);
    const limited = new FigmaRestClient(transport(() => respond(429, {}, { 'retry-after': '30' })));
    await expect(limited.me('t')).rejects.toEqual(new FigmaRateLimitError(30));
    await expect(
      new FigmaRestClient(transport(() => respond(500, {}))).me('t'),
    ).rejects.toBeInstanceOf(FigmaUnavailableError);
  });

  it('lists the top-level frames of every page, with their sizes', async () => {
    const client = new FigmaRestClient(
      transport(() =>
        respond(200, {
          name: 'Atlas booking',
          document: {
            children: [
              {
                type: 'CANVAS',
                name: 'Mobile',
                children: [
                  {
                    id: '1:2',
                    name: 'Home',
                    type: 'FRAME',
                    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
                  },
                  { id: '1:3', name: 'Note', type: 'TEXT' },
                ],
              },
            ],
          },
        }),
      ),
    );
    await expect(client.file('t', KEY)).resolves.toEqual({
      name: 'Atlas booking',
      frames: [{ nodeId: '1:2', name: 'Home', width: 390, height: 844, pageName: 'Mobile' }],
    });
  });

  it('reads node sizes and render URLs per id', async () => {
    const client = new FigmaRestClient(
      transport((url) =>
        url.includes('/nodes')
          ? respond(200, {
              name: 'F',
              nodes: {
                '1:2': {
                  document: {
                    id: '1:2',
                    name: 'A',
                    absoluteBoundingBox: { width: 10, height: 20 },
                  },
                },
                '9:9': null,
              },
            })
          : respond(200, {
              images: { '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/x.png' },
            }),
      ),
    );
    const nodes = await client.nodes('t', KEY, ['1:2', '9:9']);
    expect(nodes.nodes).toEqual([
      { nodeId: '1:2', name: 'A', width: 10, height: 20, pageName: null },
    ]);
    const urls = await client.renderUrls('t', KEY, ['1:2', '9:9'], 2);
    expect(urls.get('1:2')).toContain('amazonaws.com');
    expect(urls.get('9:9')).toBeNull();
  });

  it('downloads only a PNG from Figma or its render bucket', async () => {
    const fake = transport(() => respond(200, PNG));
    const client = new FigmaRestClient(fake);
    await expect(client.download('https://figma-alpha-api.s3.amazonaws.com/a.png')).resolves.toBe(
      PNG,
    );
    expect(fake.calls[0]?.headers).toEqual({});
    await expect(client.download('http://169.254.169.254/latest')).rejects.toBeInstanceOf(
      FigmaUnavailableError,
    );
    const notPng = new FigmaRestClient(transport(() => respond(200, new Uint8Array([1, 2, 3]))));
    await expect(notPng.download('https://www.figma.com/x')).rejects.toThrow('snapshot_not_png');
  });

  it('allows render URLs on Figma hosts and S3 only', () => {
    expect(isAllowedRenderUrl('https://s3-alpha.figma.com/img/x')).toBe(true);
    expect(isAllowedRenderUrl('https://localhost/x')).toBe(false);
    expect(isAllowedRenderUrl('https://figma.com.evil.test/x')).toBe(false);
    expect(isAllowedRenderUrl('https://user:pw@www.figma.com/x')).toBe(false);
    expect(isAllowedRenderUrl('https://www.figma.com:8443/x')).toBe(false);
  });

  it('renders at scale 2 unless the longer side would pass 4096 px', () => {
    expect(snapshotScale(390, 844)).toBe(2);
    expect(snapshotScale(1440, 3000)).toBe(1);
    expect(snapshotScale(1440, 8192)).toBe(0.5);
  });
});
