/**
 * R4 slice 13 — Figma's REST API, the few calls the proofing viewer needs, and the Figma URL
 * parser. Pure apart from the injected transport: no database, no framework.
 *
 * Calls (all with the member's personal access token in `X-Figma-Token`):
 * - `GET /v1/me` — checks a pasted token and names its owner (`handle`).
 * - `GET /v1/files/:key?depth=2` — the file's name, its pages and their top-level frames (the
 *   attach dialog's "detected frames").
 * - `GET /v1/files/:key/nodes?ids=` — names and sizes of the picked frames.
 * - `GET /v1/images/:key?ids=&format=png&scale=` — short-lived PNG render URLs.
 *
 * The render URL Figma answers is fetched only when it is `https` on Figma's own hosts or its
 * render bucket (Amazon S3), and the body must be a PNG under {@link MAX_SNAPSHOT_BYTES}: the URL
 * comes from a third party, so it is not followed anywhere else (no SSRF into the host).
 */

export const DEFAULT_FIGMA_API_BASE = 'https://api.figma.com';

/** The most frames one link may hold (SPEC R4 §6.10: Figma's rate limits). */
export const MAX_FIGMA_FRAMES = 20;

/** The most frames the attach dialog lists. */
export const MAX_DETECTED_FRAMES = 60;

/** A snapshot PNG larger than this is refused. */
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

/** Longest side, in pixels, a snapshot is rendered at (scale 2 drops to 1 above it). */
export const MAX_SNAPSHOT_SIDE = 4096;

const FILE_KEY = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID = /^(?:I?\d+[:-]\d+)(?:;\d+[:-]\d+)*$/;
const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ParsedFigmaUrl {
  readonly fileKey: string;
  /** The `node-id` in the link, as Figma's API spells it (`12:34`), or null. */
  readonly nodeId: string | null;
  /** The link normalised: https, figma.com, the path, and the node id only. */
  readonly url: string;
}

/** `12-34` (the browser's spelling) or `12:34` → `12:34`; anything else is null. */
export function normaliseNodeId(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value.length > 64 || !NODE_ID.test(value)) return null;
  return value.replace(/-/g, ':');
}

/**
 * A Figma design/file/proto link → its file key and node id. A branch link names the branch's
 * key. Anything that is not a Figma file link is `null` (the caller answers 400).
 */
export function parseFigmaUrl(raw: unknown): ParsedFigmaUrl | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !FIGMA_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter((part) => part !== '');
  const kind = parts[0];
  if (kind !== 'design' && kind !== 'file' && kind !== 'proto' && kind !== 'board') return null;
  let fileKey = parts[1];
  if (parts[2] === 'branch' && parts[3]) fileKey = parts[3];
  if (!fileKey || !FILE_KEY.test(fileKey)) return null;
  const nodeParam = url.searchParams.get('node-id');
  const nodeId = nodeParam === null ? null : normaliseNodeId(nodeParam);
  const clean = new URL(`https://www.figma.com/${parts.join('/')}`);
  if (nodeId) clean.searchParams.set('node-id', nodeId.replace(/:/g, '-'));
  return { fileKey, nodeId, url: clean.toString() };
}

/** The live-embed address (the viewer's "Live" mode), on Figma's embed host. */
export function figmaEmbedUrl(
  fileKey: string,
  nodeId: string | null,
  embedOrigin = 'https://embed.figma.com',
): string {
  const url = new URL(`${embedOrigin.replace(/\/+$/, '')}/design/${encodeURIComponent(fileKey)}`);
  if (nodeId) url.searchParams.set('node-id', nodeId.replace(/:/g, '-'));
  url.searchParams.set('embed-host', 'tmanage');
  return url.toString();
}

/** "Open in Figma". */
export function figmaOpenUrl(fileKey: string, nodeId: string | null): string {
  const url = new URL(`https://www.figma.com/design/${encodeURIComponent(fileKey)}`);
  if (nodeId) url.searchParams.set('node-id', nodeId.replace(/:/g, '-'));
  return url.toString();
}

// ─── Errors ──────────────────────────────────────────────────────────────

/** Figma refused the token (401/403 on `/me`, or 403 on a file the token cannot open). */
export class FigmaAuthError extends Error {
  constructor(readonly status: number) {
    super(`figma refused the token (${status})`);
    this.name = 'FigmaAuthError';
  }
}

export class FigmaNotFoundError extends Error {
  constructor() {
    super('figma file or node not found');
    this.name = 'FigmaNotFoundError';
  }
}

export class FigmaRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`figma rate limited (${retryAfterSeconds}s)`);
    this.name = 'FigmaRateLimitError';
  }
}

export class FigmaUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`figma unavailable: ${detail}`);
    this.name = 'FigmaUnavailableError';
  }
}

// ─── Transport ───────────────────────────────────────────────────────────

export interface FigmaResponse {
  readonly status: number;
  header(name: string): string | null;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
}

/** One GET. The default is `fetch`; tests pass a fake. */
export type FigmaTransport = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<FigmaResponse>;

export const fetchFigmaTransport: FigmaTransport = async (url, headers) => {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    header: (name) => response.headers.get(name),
    json: () => response.json() as Promise<unknown>,
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
  };
};

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface FigmaNodeSummary {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The page (canvas) it sits on; null for a node read directly. */
  readonly pageName: string | null;
}

export interface FigmaFileSummary {
  readonly name: string;
  readonly frames: readonly FigmaNodeSummary[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function size(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.round(value), 1_000_000)
    : 0;
}

/** A node's name and size from its `absoluteBoundingBox` (0 × 0 when Figma gives none). */
export function nodeSummary(raw: unknown, pageName: string | null): FigmaNodeSummary | null {
  const node = record(raw);
  if (!node) return null;
  const nodeId = typeof node['id'] === 'string' ? normaliseNodeId(node['id']) : null;
  if (!nodeId) return null;
  const box = record(node['absoluteBoundingBox']);
  return {
    nodeId,
    name: text(node['name'], 300) || nodeId,
    width: size(box?.['width']),
    height: size(box?.['height']),
    pageName,
  };
}

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'GROUP']);

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** Only Figma's own hosts and its render bucket on S3. */
export function isAllowedRenderUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return (
    host === 'figma.com' ||
    host.endsWith('.figma.com') ||
    host.endsWith('.amazonaws.com') ||
    host.endsWith('.figmausercontent.com')
  );
}

// ─── Client ──────────────────────────────────────────────────────────────

export class FigmaRestClient {
  private readonly base: string;

  constructor(
    private readonly transport: FigmaTransport = fetchFigmaTransport,
    base: string = DEFAULT_FIGMA_API_BASE,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /** Who owns the token. Throws {@link FigmaAuthError} when Figma refuses it. */
  async me(token: string): Promise<{ readonly handle: string | null }> {
    const body = record(await this.getJson(`${this.base}/v1/me`, token));
    const handle = text(body?.['handle'], 190) || text(body?.['email'], 190);
    return { handle: handle === '' ? null : handle };
  }

  /** The file's name and the top-level frames of each page (bounded). */
  async file(token: string, fileKey: string): Promise<FigmaFileSummary> {
    const body = record(
      await this.getJson(`${this.base}/v1/files/${encodeURIComponent(fileKey)}?depth=2`, token),
    );
    const document = record(body?.['document']);
    const pages = Array.isArray(document?.['children']) ? document['children'] : [];
    const frames: FigmaNodeSummary[] = [];
    for (const rawPage of pages) {
      const page = record(rawPage);
      if (!page) continue;
      const pageName = text(page['name'], 300) || null;
      const children = Array.isArray(page['children']) ? page['children'] : [];
      for (const child of children) {
        const node = record(child);
        if (!node || !FRAME_TYPES.has(String(node['type']))) continue;
        const summary = nodeSummary(node, pageName);
        if (summary) frames.push(summary);
        if (frames.length >= MAX_DETECTED_FRAMES) break;
      }
      if (frames.length >= MAX_DETECTED_FRAMES) break;
    }
    return { name: text(body?.['name'], 300), frames };
  }

  /** Names and sizes of the given nodes; a node Figma does not know is left out. */
  async nodes(
    token: string,
    fileKey: string,
    nodeIds: readonly string[],
  ): Promise<{ readonly name: string; readonly nodes: readonly FigmaNodeSummary[] }> {
    const ids = nodeIds.map(encodeURIComponent).join(',');
    const body = record(
      await this.getJson(
        `${this.base}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}`,
        token,
      ),
    );
    const nodes = record(body?.['nodes']) ?? {};
    const out: FigmaNodeSummary[] = [];
    for (const id of nodeIds) {
      const entry = record(nodes[id]);
      const summary = nodeSummary(entry?.['document'], null);
      if (summary) out.push(summary);
    }
    return { name: text(body?.['name'], 300), nodes: out };
  }

  /** PNG render URLs per node id (null where Figma could not render one). */
  async renderUrls(
    token: string,
    fileKey: string,
    nodeIds: readonly string[],
    scale: number,
  ): Promise<ReadonlyMap<string, string | null>> {
    const ids = nodeIds.map(encodeURIComponent).join(',');
    const body = record(
      await this.getJson(
        `${this.base}/v1/images/${encodeURIComponent(fileKey)}?ids=${ids}&format=png&scale=${scale}`,
        token,
      ),
    );
    const images = record(body?.['images']) ?? {};
    const out = new Map<string, string | null>();
    for (const id of nodeIds) {
      const value = images[id];
      out.set(id, typeof value === 'string' && value !== '' ? value : null);
    }
    return out;
  }

  /** The PNG bytes of a render URL (no token: the URL is pre-signed). */
  async download(url: string): Promise<Uint8Array> {
    if (!isAllowedRenderUrl(url)) throw new FigmaUnavailableError('render_url_refused');
    const response = await this.transport(url, {});
    this.raiseFor(response, false);
    const length = Number(response.header('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_SNAPSHOT_BYTES) {
      throw new FigmaUnavailableError('snapshot_too_large');
    }
    const bytes = await response.bytes();
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new FigmaUnavailableError('snapshot_too_large');
    if (!isPng(bytes)) throw new FigmaUnavailableError('snapshot_not_png');
    return bytes;
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    const response = await this.transport(url, figmaAuthHeaders(token));
    this.raiseFor(response, true);
    try {
      return await response.json();
    } catch {
      throw new FigmaUnavailableError('bad_json');
    }
  }

  private raiseFor(response: FigmaResponse, authed: boolean): void {
    if (response.status >= 200 && response.status < 300) return;
    if (authed && (response.status === 401 || response.status === 403)) {
      throw new FigmaAuthError(response.status);
    }
    if (response.status === 404) throw new FigmaNotFoundError();
    if (response.status === 429) {
      const retry = Number(response.header('retry-after') ?? '60');
      throw new FigmaRateLimitError(Number.isFinite(retry) && retry > 0 ? retry : 60);
    }
    throw new FigmaUnavailableError(`status_${response.status}`);
  }
}

/** Scale 2 unless the frame's longer side would pass {@link MAX_SNAPSHOT_SIDE}. */
export function snapshotScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  if (longest * 2 <= MAX_SNAPSHOT_SIDE) return 2;
  if (longest <= MAX_SNAPSHOT_SIDE) return 1;
  return Math.max(0.01, Math.floor((MAX_SNAPSHOT_SIDE / longest) * 100) / 100);
}

/**
 * FIX4 item 6. A token from Figma's one-click Connect is stored as `oauth:<access token>` and sent
 * as a bearer token; a pasted personal access token goes in `X-Figma-Token`.
 */
export function figmaAuthHeaders(token: string): Record<string, string> {
  return token.startsWith('oauth:')
    ? { Authorization: `Bearer ${token.slice('oauth:'.length)}` }
    : { 'X-Figma-Token': token };
}
