/**
 * R4 slice 13 — Figma's REST API, the few calls the proofing viewer needs, and the Figma URL
 * parser. Pure apart from the injected transport: no database, no framework.
 *
 * Calls (all with the member's personal access token in `X-Figma-Token`):
 * - `GET /v1/me` — checks a pasted token and names its owner (`handle`).
 * - `GET /v1/files/:key?depth=1` — the file's name and its pages.
 * - `GET /v1/files/:key/nodes?ids=&depth=1` — the children of pages and sections, level by level,
 *   so frames inside sections (and nested sections) are found too ({@link FigmaRestClient.outline}).
 * - `GET /v1/files/:key/nodes?ids=` — names and sizes of named frames.
 * - `GET /v1/images/:key?ids=&format=png&scale=` — short-lived PNG render URLs.
 *
 * The render URL Figma answers is fetched only when it is `https` on Figma's own hosts or its
 * render bucket (Amazon S3), and the body must be a PNG under {@link MAX_SNAPSHOT_BYTES}: the URL
 * comes from a third party, so it is not followed anywhere else (no SSRF into the host).
 */

export const DEFAULT_FIGMA_API_BASE = 'https://api.figma.com';

/**
 * Peter, 2026-11-10 ("it's not capturing the whole page with all its frames"). The most frames
 * one link captures (snapshots drawn and stored). A file with more lists every frame, captures
 * this many in order of relevance, and the team chooses pages. Protects the workspace's Figma
 * quota and its storage (a snapshot is about 1–3 MB). Was 20 picked by hand.
 */
export const MAX_CAPTURED_FRAMES = 250;

/** The most frames read from one file's outline; above it the outline says `truncated`. */
export const MAX_OUTLINE_FRAMES = 2000;

/** How deep sections inside sections are walked. */
export const MAX_SECTION_DEPTH = 4;

/** Node ids per `nodes` / `images` request (Figma answers large id lists slowly). */
export const NODES_PER_REQUEST = 40;

/** A snapshot PNG larger than this is refused. */
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

/** A sharper (zoom) render PNG larger than this is refused. */
export const MAX_RENDER_BYTES = 48 * 1024 * 1024;

/** Longest side, in pixels, a snapshot is rendered at (scale 2 drops to 1 above it). */
export const MAX_SNAPSHOT_SIDE = 4096;

/** Figma renders at most 4×. */
export const MAX_RENDER_SCALE = 4;

/** Longest side and pixel count of a sharper render (Figma scales larger exports down). */
export const MAX_RENDER_SIDE = 16_384;
export const MAX_RENDER_PIXELS = 32_000_000;

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

/** How long TManage waits after a 429 when Figma names no time. */
export const FIGMA_WAIT_FLOOR_MS = 60_000;
/** The longest TManage waits for one 429 (Figma can name days); it asks again after this. */
export const FIGMA_WAIT_CEILING_MS = 60 * 60_000;

/** The wait after Figma's 429, from its Retry-After, kept between the floor and the ceiling. */
export function figmaWaitMs(retryAfterSeconds: number): number {
  return Math.min(FIGMA_WAIT_CEILING_MS, Math.max(FIGMA_WAIT_FLOOR_MS, retryAfterSeconds * 1000));
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

/** One frame of a file's outline: what it is, where it sits, what it is grouped under. */
export interface FigmaOutlineFrame {
  readonly nodeId: string;
  readonly name: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  /** Position on the page's canvas (Figma's absolute coordinates). */
  readonly x: number;
  readonly y: number;
  readonly pageId: string;
  readonly pageName: string;
  /** The section(s) it sits in, outermost first (`Onboarding / Step 2`), or null. */
  readonly sectionName: string | null;
}

export interface FigmaOutlinePage {
  readonly id: string;
  readonly name: string;
}

/** The whole file: its pages, and every frame on them in Figma's order. */
export interface FigmaOutline {
  readonly name: string;
  readonly pages: readonly FigmaOutlinePage[];
  readonly frames: readonly FigmaOutlineFrame[];
  /** More than {@link MAX_OUTLINE_FRAMES} frames, or sections nested deeper than walked. */
  readonly truncated: boolean;
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

function coordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1_000_000_000, Math.min(Math.round(value), 1_000_000_000))
    : 0;
}

function children(node: Record<string, unknown> | null): readonly unknown[] {
  return Array.isArray(node?.['children']) ? (node['children'] as unknown[]) : [];
}

/** Figma's layer order: compare two index paths (page, then position at each level). */
function compareOrder(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
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

/** What designers use as an artboard, on a page or inside a section. */
export const FRAME_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'COMPONENT',
  'COMPONENT_SET',
  'GROUP',
  'INSTANCE',
]);

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** Figma's render bucket on S3, path-style region or not (`figma-alpha-api.s3.us-west-2…`). */
const FIGMA_RENDER_BUCKET = /^figma-alpha-api\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/u;

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
    // Security review L4 (2026-11-14): Figma's own render bucket only, not any S3 bucket.
    FIGMA_RENDER_BUCKET.test(host) ||
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

  /**
   * The whole file: its pages (`depth=1`), then the children of every page and section one level
   * per round, {@link NODES_PER_REQUEST} ids per call, so frames inside sections and nested
   * sections are found (the old `depth=2` read saw only frames placed straight on a page). Hidden
   * nodes are left out. Bounded by {@link MAX_OUTLINE_FRAMES} and {@link MAX_SECTION_DEPTH}; the
   * frames come back in Figma's order (page, then layer order at each level).
   */
  async outline(token: string, fileKey: string): Promise<FigmaOutline> {
    const key = encodeURIComponent(fileKey);
    const body = record(await this.getJson(`${this.base}/v1/files/${key}?depth=1`, token));
    const pages: FigmaOutlinePage[] = [];
    for (const raw of children(record(body?.['document']))) {
      const page = record(raw);
      const id = typeof page?.['id'] === 'string' ? normaliseNodeId(page['id']) : null;
      if (!page || !id || page['type'] !== 'CANVAS') continue;
      pages.push({ id, name: text(page['name'], 300) || id });
    }
    interface Container {
      readonly id: string;
      readonly page: FigmaOutlinePage;
      readonly section: string | null;
      readonly order: readonly number[];
    }
    const found: { readonly frame: FigmaOutlineFrame; readonly order: readonly number[] }[] = [];
    let truncated = false;
    let level: Container[] = pages.map((page, index) => ({
      id: page.id,
      page,
      section: null,
      order: [index],
    }));
    for (let depth = 0; level.length > 0; depth += 1) {
      if (depth > MAX_SECTION_DEPTH) {
        truncated = true;
        break;
      }
      const next: Container[] = [];
      for (let at = 0; at < level.length; at += NODES_PER_REQUEST) {
        const batch = level.slice(at, at + NODES_PER_REQUEST);
        const ids = batch.map((item) => encodeURIComponent(item.id)).join(',');
        const answer = record(
          await this.getJson(`${this.base}/v1/files/${key}/nodes?ids=${ids}&depth=1`, token),
        );
        const nodes = record(answer?.['nodes']) ?? {};
        for (const container of batch) {
          const parent = record(record(nodes[container.id])?.['document']);
          children(parent).forEach((raw, index) => {
            const node = record(raw);
            if (!node || node['visible'] === false) return;
            const id = typeof node['id'] === 'string' ? normaliseNodeId(node['id']) : null;
            if (!id) return;
            const type = String(node['type']);
            const order = [...container.order, index];
            if (type === 'SECTION') {
              const name = text(node['name'], 300) || id;
              const section = container.section ? `${container.section} / ${name}` : name;
              next.push({ id, page: container.page, section: section.slice(0, 300), order });
              return;
            }
            if (!FRAME_TYPES.has(type)) return;
            if (found.length >= MAX_OUTLINE_FRAMES) {
              truncated = true;
              return;
            }
            const box = record(node['absoluteBoundingBox']);
            found.push({
              order,
              frame: {
                nodeId: id,
                name: text(node['name'], 300) || id,
                type,
                width: size(box?.['width']),
                height: size(box?.['height']),
                x: coordinate(box?.['x']),
                y: coordinate(box?.['y']),
                pageId: container.page.id,
                pageName: container.page.name,
                sectionName: container.section,
              },
            });
          });
        }
      }
      level = next;
    }
    found.sort((a, b) => compareOrder(a.order, b.order));
    return {
      name: text(body?.['name'], 300),
      pages,
      frames: found.map((item) => item.frame),
      truncated,
    };
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

  /** The PNG bytes of a render URL (no token: the URL is pre-signed), at most `maxBytes`. */
  async download(url: string, maxBytes: number = MAX_SNAPSHOT_BYTES): Promise<Uint8Array> {
    if (!isAllowedRenderUrl(url)) throw new FigmaUnavailableError('render_url_refused');
    const response = await this.transport(url, {});
    this.raiseFor(response, false);
    const length = Number(response.header('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBytes) {
      throw new FigmaUnavailableError('snapshot_too_large');
    }
    const bytes = await response.bytes();
    if (bytes.length > maxBytes) throw new FigmaUnavailableError('snapshot_too_large');
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
 * The scale of a sharper render for zooming in: as close to Figma's 4× as the frame allows under
 * {@link MAX_RENDER_SIDE} and {@link MAX_RENDER_PIXELS}. Figma cannot export part of a frame
 * (no tiles), so a large frame gets a lower scale instead. `null` when that would be no sharper
 * than the snapshot already shown.
 */
export function renderScale(width: number, height: number): number | null {
  if (width <= 0 || height <= 0) return null;
  const bySide = MAX_RENDER_SIDE / Math.max(width, height);
  const byPixels = Math.sqrt(MAX_RENDER_PIXELS / (width * height));
  const scale = Math.floor(Math.min(MAX_RENDER_SCALE, bySide, byPixels) * 100) / 100;
  return scale >= snapshotScale(width, height) + 0.25 ? scale : null;
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
