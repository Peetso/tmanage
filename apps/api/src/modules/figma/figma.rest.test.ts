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
  MAX_OUTLINE_FRAMES,
  MAX_RENDER_SCALE,
  NODES_PER_REQUEST,
  parseFigmaUrl,
  renderScale,
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

  /** A fake Figma file: pages, sections inside sections, frames; answers `files` and `nodes`. */
  function fileTransport(tree: Record<string, readonly Record<string, unknown>[]>) {
    return transport((url) => {
      if (url.includes('/nodes?')) {
        const ids = decodeURIComponent(new URL(url).searchParams.get('ids') ?? '').split(',');
        return respond(200, {
          nodes: Object.fromEntries(
            ids.map((id) => [id, { document: { id, children: tree[id] ?? [] } }]),
          ),
        });
      }
      return respond(200, {
        name: 'Atlas booking',
        document: {
          children: [
            { id: '0:1', type: 'CANVAS', name: 'Mobile' },
            { id: '0:2', type: 'CANVAS', name: 'Desktop' },
          ],
        },
      });
    });
  }

  const box = (x: number, y: number) => ({ x, y, width: 390, height: 844 });

  it('reads the whole file: frames on pages, inside sections and nested sections, in order', async () => {
    const fake = fileTransport({
      '0:1': [
        { id: '1:1', name: 'Home', type: 'FRAME', absoluteBoundingBox: box(0, 0) },
        { id: '1:9', name: 'Note', type: 'TEXT' },
        { id: '2:1', name: 'Onboarding', type: 'SECTION' },
        { id: '1:5', name: 'Hidden', type: 'FRAME', visible: false },
        { id: '1:6', name: 'Card', type: 'COMPONENT', absoluteBoundingBox: box(900, 0) },
      ],
      '2:1': [
        { id: '2:2', name: 'Step 1', type: 'FRAME', absoluteBoundingBox: box(0, 1000) },
        { id: '2:3', name: 'Later', type: 'SECTION' },
      ],
      '2:3': [{ id: '2:4', name: 'Step 9', type: 'GROUP', absoluteBoundingBox: box(0, 2000) }],
      '0:2': [{ id: '3:1', name: 'Wide', type: 'FRAME', absoluteBoundingBox: box(-50, 7) }],
    });
    const outline = await new FigmaRestClient(fake).outline('t', KEY);
    expect(outline.name).toBe('Atlas booking');
    expect(outline.pages).toEqual([
      { id: '0:1', name: 'Mobile' },
      { id: '0:2', name: 'Desktop' },
    ]);
    expect(outline.truncated).toBe(false);
    expect(outline.frames.map((frame) => [frame.nodeId, frame.sectionName, frame.pageId])).toEqual([
      ['1:1', null, '0:1'],
      ['2:2', 'Onboarding', '0:1'],
      ['2:4', 'Onboarding / Later', '0:1'],
      ['1:6', null, '0:1'],
      ['3:1', null, '0:2'],
    ]);
    expect(outline.frames[4]).toMatchObject({ x: -50, y: 7, width: 390, pageName: 'Desktop' });
    // The file at depth 1, then one `nodes` call per level (pages, then sections, then nested).
    expect(fake.calls[0]?.url).toContain(`/v1/files/${KEY}?depth=1`);
    expect(fake.calls.filter((call) => call.url.includes('/nodes?'))).toHaveLength(3);
  });

  it('reads a page with more containers than one request holds in several requests', async () => {
    const sections = Array.from({ length: NODES_PER_REQUEST + 5 }, (_, index) => ({
      id: `5:${index + 1}`,
      name: `S${index + 1}`,
      type: 'SECTION',
    }));
    const tree: Record<string, readonly Record<string, unknown>[]> = { '0:1': sections };
    for (const section of sections) {
      tree[section.id] = [
        {
          id: `6:${section.id.slice(2)}`,
          name: 'F',
          type: 'FRAME',
          absoluteBoundingBox: box(0, 0),
        },
      ];
    }
    const fake = fileTransport(tree);
    const outline = await new FigmaRestClient(fake).outline('t', KEY);
    expect(outline.frames).toHaveLength(NODES_PER_REQUEST + 5);
    // pages: 1 call; sections: 2 calls (40 + 5).
    expect(fake.calls.filter((call) => call.url.includes('/nodes?'))).toHaveLength(3);
  });

  it('stops at the outline cap and says it was cut short', async () => {
    const many = Array.from({ length: MAX_OUTLINE_FRAMES + 3 }, (_, index) => ({
      id: `7:${index + 1}`,
      name: 'F',
      type: 'FRAME',
      absoluteBoundingBox: box(index, 0),
    }));
    const outline = await new FigmaRestClient(fileTransport({ '0:1': many })).outline('t', KEY);
    expect(outline.frames).toHaveLength(MAX_OUTLINE_FRAMES);
    expect(outline.truncated).toBe(true);
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
    // Review L4: Figma's render bucket only, not any S3 bucket.
    expect(isAllowedRenderUrl('https://figma-alpha-api.s3.us-west-2.amazonaws.com/x.png')).toBe(
      true,
    );
    expect(isAllowedRenderUrl('https://attacker-bucket.s3.amazonaws.com/x.png')).toBe(false);
    expect(isAllowedRenderUrl('https://figma-alpha-api.s3.amazonaws.com.evil.test/x')).toBe(false);
    expect(isAllowedRenderUrl('https://figma.com.evil.test/x')).toBe(false);
    expect(isAllowedRenderUrl('https://user:pw@www.figma.com/x')).toBe(false);
    expect(isAllowedRenderUrl('https://www.figma.com:8443/x')).toBe(false);
  });

  it('renders at scale 2 unless the longer side would pass 4096 px', () => {
    expect(snapshotScale(390, 844)).toBe(2);
    expect(snapshotScale(1440, 3000)).toBe(1);
    expect(snapshotScale(1440, 8192)).toBe(0.5);
  });

  it('renders sharper for zoom: 4x when it fits, lower for a big frame, none when no sharper', () => {
    expect(renderScale(390, 844)).toBe(MAX_RENDER_SCALE);
    // 1440 x 9000 at 1x is 13 M px: the 32 M px cap allows 1.57x (the snapshot is 0.45x).
    expect(renderScale(1440, 9000)).toBe(1.57);
    // A huge frame whose snapshot is already as sharp as Figma can render: no render.
    expect(renderScale(16_000, 16_000)).toBeNull();
    expect(renderScale(0, 0)).toBeNull();
  });
});
