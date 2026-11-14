import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import { ObjectNotFoundError, type ObjectStore } from '@tmanage/storage';
import { Readable } from 'node:stream';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  FigmaConnectionRow,
  FigmaFrameRow,
  FigmaLinkRow,
  ProjectRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { FigmaAccess } from './figma-access.js';
import type { FigmaRepository, InsertLinkInput } from './figma.repository.js';
import {
  FigmaAuthError,
  MAX_CAPTURED_FRAMES,
  MAX_RENDER_SCALE,
  type FigmaOutline,
  type FigmaRestClient,
} from './figma.rest.js';
import type { FrameDiff } from './figma-outline.js';
import { FigmaService, figmaTokenBinding } from './figma.service.js';
import { FigmaOAuthRefusedError } from './figma-oauth.js';
import { pkceChallenge } from '../../common/http/oauth-flow.js';

/**
 * R4 slice 13 — the Figma service with fakes: the token is stored encrypted and only its hint is
 * echoed; a token Figma refuses is a 422; a client reads only client-visible links and never the
 * Figma address, file key or live embed; a link attaches only with a connection and on the
 * project the target belongs to; the frame gate answers the review service the same way.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';
const LINK = '00000000-0000-4000-8000-0000000000d1';
const INTERNAL_LINK = '00000000-0000-4000-8000-0000000000d2';
const FRAME = '00000000-0000-4000-8000-0000000000f1';
const ITEM = '00000000-0000-4000-8000-000000000301';
const STAFF_M = '00000000-0000-4000-8000-0000000000e1';
const CLIENT_M = '00000000-0000-4000-8000-0000000000e2';
const CLIENT_ORG = '00000000-0000-4000-8000-000000000201';
const KEY = 'ZdUCRiqBiT7s3u08HA28RO';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x52).toString('base64url')}`));
const NOW = new Date('2026-11-01T10:00:00Z');
const TOKEN = 'figd_0123456789abcdefghijWXYZ';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const STAFF: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  kind: 'internal',
  role: 'manager',
  membershipId: STAFF_M,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
} as Principal;

const CLIENT: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c2',
  organizationId: ORG,
  kind: 'client',
  role: 'client_reviewer',
  membershipId: CLIENT_M,
  membershipStatus: 'active',
  clientOrganizationId: CLIENT_ORG,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
} as Principal;

function contextOf(who: Principal): TenantContext {
  return {
    organizationId: ORG,
    membershipId: who.membershipId,
    userId: who.userId,
    principalKind: who.kind,
  } as unknown as TenantContext;
}

function linkRow(id: string, audience: string): FigmaLinkRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    fileKey: KEY,
    fileName: 'Atlas booking flow',
    url: `https://www.figma.com/design/${KEY}`,
    attachedToType: 'work_item',
    attachedToId: ITEM,
    audience,
    createdByMembershipId: STAFF_M,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    captureMode: 'whole_file',
    focusNodeId: null,
    outlineJson: JSON.stringify({ pages: [{ id: '0:1', name: 'Mobile' }], truncated: false }),
    pageFilterJson: null,
    // Read from Figma an hour ago: past the refresh cooldown.
    syncedAt: new Date(NOW.getTime() - 60 * 60_000),
  };
}

function frameRow(id: string, nodeId: string, over: Partial<FigmaFrameRow> = {}): FigmaFrameRow {
  return {
    id,
    organizationId: ORG,
    linkId: LINK,
    nodeId,
    name: 'Booking — Step 2',
    width: 390,
    height: 844,
    snapshotObjectKey: `tenant/${ORG}/figma/${LINK}/${id}`,
    snapshotHash: 'a'.repeat(64),
    snapshotStatus: 'ready',
    snapshotAttempts: 0,
    claimedAt: null,
    capturedAt: NOW,
    sizeChanged: true,
    sortOrder: 0,
    pageId: '0:1',
    pageName: 'Mobile',
    sectionName: null,
    posX: 0,
    posY: 0,
    captureRank: 0,
    goneAt: null,
    hasThumb: true,
    snapshotError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** A Figma file's outline for the fake: `count` frames over two pages, the first in a section. */
function outlineOf(count: number): FigmaOutline {
  return {
    name: 'Atlas booking flow',
    pages: [
      { id: '0:1', name: 'Mobile' },
      { id: '0:2', name: 'Desktop' },
    ],
    frames: Array.from({ length: count }, (_, index) => ({
      nodeId: `1:${index + 2}`,
      name: `Frame ${index + 1}`,
      type: 'FRAME',
      width: 390,
      height: 844,
      x: index * 400,
      y: 0,
      pageId: index % 2 === 0 ? '0:1' : '0:2',
      pageName: index % 2 === 0 ? 'Mobile' : 'Desktop',
      sectionName: index === 0 ? 'Onboarding' : null,
    })),
    truncated: false,
  };
}

function build(
  options: {
    connected?: boolean;
    figmaRefuses?: boolean;
    oauth?: boolean;
    outline?: FigmaOutline;
    rendersPerPerson?: number;
    exchange?: (input: { readonly verifier?: string | undefined }) => Promise<{
      readonly accessToken: string;
    }>;
  } = {},
) {
  const connections = new Map<string, FigmaConnectionRow>();
  if (options.connected) {
    connections.set(STAFF_M, {
      id: 'c1',
      organizationId: ORG,
      membershipId: STAFF_M,
      tokenCiphertext: CIPHER.encrypt(TOKEN, figmaTokenBinding(ORG, STAFF_M)),
      tokenHint: 'WXYZ',
      figmaUserHandle: 'lina',
      status: 'connected',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const links = new Map<string, FigmaLinkRow>([
    [LINK, linkRow(LINK, 'client_visible')],
    [INTERNAL_LINK, linkRow(INTERNAL_LINK, 'internal')],
  ]);
  const frames: FigmaFrameRow[] = [frameRow(FRAME, '1:2')];
  const inserted: InsertLinkInput[] = [];
  const diffs: FrameDiff[] = [];
  const audits: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const renderCalls: number[] = [];
  const repository = {
    findConnection: async (_r: unknown, _c: unknown, m: string) => connections.get(m),
    saveConnection: async (
      _r: unknown,
      _c: unknown,
      input: {
        membershipId: string;
        tokenCiphertext: string;
        tokenHint: string;
        handle: string | null;
      },
    ) => {
      connections.set(input.membershipId, {
        id: 'c2',
        organizationId: ORG,
        membershipId: input.membershipId,
        tokenCiphertext: input.tokenCiphertext,
        tokenHint: input.tokenHint,
        figmaUserHandle: input.handle,
        status: 'connected',
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
    deleteConnection: async (_r: unknown, _c: unknown, m: string) => connections.delete(m),
    markConnectionError: async () => undefined,
    findLink: async (_r: unknown, _c: unknown, id: string) => links.get(id),
    listFrames: async (_r: unknown, _c: unknown, id: string) =>
      frames.filter((f) => f.linkId === id),
    findFrame: async (_r: unknown, _c: unknown, id: string) => frames.find((f) => f.id === id),
    attachTargetProject: async (_r: unknown, _c: unknown, _t: string, id: string) =>
      id === ITEM ? PROJECT : OTHER_PROJECT,
    insertLink: async (_r: unknown, _c: unknown, input: InsertLinkInput) => {
      inserted.push(input);
      links.set(LINK, { ...linkRow(LINK, input.audience) });
      return LINK;
    },
    applyFrameDiff: async (_r: unknown, _c: unknown, _l: string, diff: FrameDiff) => {
      diffs.push(diff);
    },
    updateLinkOutline: async () => undefined,
    listLinksAttachedTo: async () => [...links.values()],
  } as unknown as FigmaRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === PROJECT
        ? ({ id: PROJECT, organizationId: ORG, archivedAt: null } as unknown as ProjectRow)
        : null,
  };
  const threads = { countOpenBySubjects: async () => new Map([[FRAME, 2]]) };
  const rest = {
    me: async (token: string) => {
      if (options.figmaRefuses) throw new FigmaAuthError(403);
      return { handle: token ? 'lina' : null };
    },
    outline: async () => options.outline ?? outlineOf(1),
    renderUrls: async (_t: string, _k: string, ids: readonly string[], scale: number) => {
      renderCalls.push(scale);
      return new Map(ids.map((id) => [id, 'https://figma-alpha-api.s3.amazonaws.com/r.png']));
    },
    download: async () => PNG,
    nodes: async (_t: string, _k: string, ids: readonly string[]) => ({
      name: 'Atlas booking flow',
      nodes: ids.map((nodeId) => ({
        nodeId,
        name: 'Home',
        width: 390,
        height: 844,
        pageName: null,
      })),
    }),
  } as unknown as FigmaRestClient;
  const runner = {};
  const database = {
    read: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
    transaction: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
  } as unknown as TenantDatabase;
  const audit = {
    record: async (_tx: unknown, _c: unknown, entry: { action: string }) => {
      audits.push(entry.action);
    },
  } as unknown as AuditService;
  let requested = 0;
  const service = new FigmaService({
    database,
    audit,
    cipher: CIPHER,
    rest,
    store: {
      putDerivative: async ({ objectKey, body }: { objectKey: string; body: Uint8Array }) => {
        stored.set(objectKey, body);
        return { sizeBytes: body.length };
      },
      openDerivative: async ({ objectKey }: { objectKey: string }) => {
        const body = stored.get(objectKey);
        if (!body) throw new ObjectNotFoundError();
        return { sizeBytes: body.length, stream: Readable.from([body]) };
      },
    } as unknown as ObjectStore,
    snapshots: { request: () => (requested += 1) },
    repository,
    projects,
    threads,
    now: () => NOW,
    renderAdmission: {
      workspace: createFixedWindowLimiter({ windowMs: 60_000, max: 100 }),
      person: createFixedWindowLimiter({ windowMs: 60_000, max: options.rendersPerPerson ?? 100 }),
    },
    ...(options.oauth
      ? {
          oauth: { clientId: 'figma-client', clientSecret: 'figma-secret' },
          apiPublicUrl: 'https://api.example.test/',
          exchange: options.exchange ?? (async () => ({ accessToken: 'figu_oauth_token_9876' })),
        }
      : {}),
  });
  const access = new FigmaAccess(database, repository, projects);
  return {
    service,
    access,
    connections,
    inserted,
    diffs,
    frames,
    renderCalls,
    audits,
    links,
    requested: () => requested,
  };
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

describe('FigmaService · connection', () => {
  it('stores the token encrypted to the member and echoes only its last four characters', async () => {
    const world = build();
    const view = await world.service.connect(contextOf(STAFF), STAFF, { token: ` ${TOKEN} ` });
    expect(view).toEqual({
      status: 'connected',
      handle: 'lina',
      tokenHint: 'WXYZ',
      oneClick: false,
    });
    const row = world.connections.get(STAFF_M)!;
    expect(row.tokenCiphertext).not.toContain(TOKEN);
    expect(CIPHER.decrypt(row.tokenCiphertext, figmaTokenBinding(ORG, STAFF_M))).toBe(TOKEN);
    expect(() => CIPHER.decrypt(row.tokenCiphertext, figmaTokenBinding(ORG, CLIENT_M))).toThrow();
    expect(world.audits).toEqual(['figma.connection_changed']);
  });

  it('refuses a token Figma does not accept, and a client principal', async () => {
    const world = build({ figmaRefuses: true });
    expect(await status(world.service.connect(contextOf(STAFF), STAFF, { token: TOKEN }))).toBe(
      422,
    );
    expect(await status(world.service.connect(contextOf(STAFF), STAFF, { token: 'short' }))).toBe(
      422,
    );
    expect(await status(world.service.connection(contextOf(CLIENT), CLIENT))).toBe(404);
  });
});

describe('FigmaService · one-click Connect (FIX4 item 6)', () => {
  const flowOf = (state = 'state-1', membershipId = STAFF_M) => ({
    organizationId: ORG,
    organizationSlug: 'acme',
    membershipId,
    returnTo: 'integrations' as const,
    state,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  });

  it('says whether the server offers one-click Connect', async () => {
    expect((await build().service.connection(contextOf(STAFF), STAFF)).oneClick).toBe(false);
    const world = build({ oauth: true });
    expect((await world.service.connection(contextOf(STAFF), STAFF)).oneClick).toBe(true);
  });

  it('starts at the Figma consent screen with the callback and a fresh state', () => {
    const { url, flow } = build({ oauth: true }).service.startConnect(
      contextOf(STAFF),
      STAFF,
      'acme',
    );
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe('https://www.figma.com/oauth');
    expect(address.searchParams.get('client_id')).toBe('figma-client');
    expect(address.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/v1/integrations/figma/callback',
    );
    expect(address.searchParams.get('state')).toBe(flow.state);
    expect(address.searchParams.get('response_type')).toBe('code');
    expect(flow.membershipId).toBe(STAFF_M);
    expect(() => build().service.startConnect(contextOf(STAFF), STAFF, 'acme')).toThrow(ApiError);
  });

  it('uses PKCE S256: challenge on the consent address, verifier on the exchange (L5)', async () => {
    const verifiers: (string | undefined)[] = [];
    const world = build({
      oauth: true,
      exchange: async (input) => {
        verifiers.push(input.verifier);
        return { accessToken: 'figu_oauth_token_9876' };
      },
    });
    const { url, flow } = world.service.startConnect(contextOf(STAFF), STAFF, 'acme');
    const address = new URL(url);
    expect(address.searchParams.get('code_challenge')).toBe(pkceChallenge(flow.verifier!));
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    await world.service.completeConnect(contextOf(STAFF), STAFF, flow, {
      code: 'code-1',
      state: flow.state,
    });
    // A flow sealed before PKCE (no verifier) still completes, and sends no verifier.
    await world.service.completeConnect(contextOf(STAFF), STAFF, flowOf(), {
      code: 'code-2',
      state: 'state-1',
    });
    expect(verifiers).toEqual([flow.verifier, undefined]);
  });

  it('stores the OAuth token encrypted, marked as a bearer token, and audits', async () => {
    const world = build({ oauth: true });
    const view = await world.service.completeConnect(contextOf(STAFF), STAFF, flowOf(), {
      code: 'code-1',
      state: 'state-1',
    });
    expect(view).toEqual({
      status: 'connected',
      handle: 'lina',
      tokenHint: '9876',
      oneClick: true,
    });
    const row = world.connections.get(STAFF_M)!;
    expect(CIPHER.decrypt(row.tokenCiphertext, figmaTokenBinding(ORG, STAFF_M))).toBe(
      'oauth:figu_oauth_token_9876',
    );
    expect(world.audits).toEqual(['figma.connection_changed']);
  });

  it('refuses a wrong state, a flow for someone else, no flow and a refused code', async () => {
    const world = build({ oauth: true });
    const ctx = contextOf(STAFF);
    expect(
      await status(world.service.completeConnect(ctx, STAFF, flowOf(), { code: 'c', state: 'x' })),
    ).toBe(422);
    expect(
      await status(
        world.service.completeConnect(ctx, STAFF, flowOf('s', CLIENT_M), { code: 'c', state: 's' }),
      ),
    ).toBe(422);
    expect(
      await status(world.service.completeConnect(ctx, STAFF, undefined, { code: 'c', state: 's' })),
    ).toBe(422);
    const refusing = build({
      oauth: true,
      exchange: async () => {
        throw new FigmaOAuthRefusedError('no');
      },
    });
    expect(
      await status(
        refusing.service.completeConnect(ctx, STAFF, flowOf(), { code: 'c', state: 'state-1' }),
      ),
    ).toBe(422);
    expect(world.connections.size).toBe(0);
  });
});

describe('FigmaService · attach', () => {
  const url = `https://www.figma.com/design/${KEY}/Atlas?node-id=1-2`;

  it('needs a connection first (409)', async () => {
    const world = build();
    expect(await status(world.service.attach(contextOf(STAFF), STAFF, PROJECT, { url }))).toBe(409);
  });

  it('attaches the whole file, opens on the linked frame and queues the snapshots', async () => {
    const world = build({ connected: true, outline: outlineOf(3) });
    const view = await world.service.attach(contextOf(STAFF), STAFF, PROJECT, {
      url,
      audience: 'client_visible',
      attachedTo: { type: 'work_item', id: ITEM },
    });
    expect(view.id).toBe(LINK);
    expect(world.inserted[0]).toMatchObject({
      fileKey: KEY,
      audience: 'client_visible',
      attachedToType: 'work_item',
      captureMode: 'whole_file',
      focusNodeId: '1:2',
    });
    const listed = world.inserted[0]!.frames;
    expect(listed.map((item) => item.frame.nodeId)).toEqual(['1:2', '1:3', '1:4']);
    expect(listed[0]).toMatchObject({
      frame: { sectionName: 'Onboarding', pageId: '0:1' },
      placement: { captureRank: 0, captured: true },
    });
    // The linked frame first, then the rest of its page, then the other page.
    expect(listed.map((item) => item.placement.captureRank)).toEqual([0, 2, 1]);
    expect(world.audits).toContain('figma.link_attached');
    expect(world.requested()).toBe(1);
  });

  it('refuses a target on another project, a bad link and too many frames', async () => {
    const world = build({ connected: true });
    const other = '00000000-0000-4000-8000-000000000399';
    expect(
      await status(
        world.service.attach(contextOf(STAFF), STAFF, PROJECT, {
          url,
          attachedTo: { type: 'work_item', id: other },
        }),
      ),
    ).toBe(422);
    expect(
      await status(
        world.service.attach(contextOf(STAFF), STAFF, PROJECT, { url: 'https://x.test' }),
      ),
    ).toBe(422);
    const many = Array.from({ length: MAX_CAPTURED_FRAMES + 1 }, (_, i) => `1:${i + 1}`);
    expect(
      await status(world.service.attach(contextOf(STAFF), STAFF, PROJECT, { url, nodeIds: many })),
    ).toBe(422);
    expect(
      await status(world.service.attach(contextOf(STAFF), STAFF, OTHER_PROJECT, { url })),
    ).toBe(404);
  });
});

describe('FigmaService · reading a link', () => {
  it('gives staff the live embed and Figma address', async () => {
    const world = build();
    const view = await world.service.link(contextOf(STAFF), STAFF, 'internal', LINK);
    expect(view.openUrl).toContain('figma.com/design/');
    expect(view.frames[0]).toMatchObject({
      id: FRAME,
      sizeChanged: true,
      openThreads: 2,
      snapshotPath: `/figma/frames/${FRAME}/snapshot?v=aaaaaaaaaaaa`,
    });
    expect(view.frames[0]?.embedUrl).toContain('embed.figma.com');
    expect(view.capabilities).toEqual({
      canComment: true,
      canRefresh: true,
      canRemove: true,
      canLive: true,
    });
  });

  it('gives a client snapshot mode only, and no internal link at all', async () => {
    const world = build();
    const view = await world.service.link(contextOf(CLIENT), CLIENT, 'client', LINK);
    expect(view.openUrl).toBeNull();
    expect(view.attachedToId).toBeNull();
    expect(view.frames[0]?.embedUrl).toBeNull();
    expect(view.frames[0]?.snapshotPath).toMatch(/^\/portal\/figma\/frames\//);
    expect(view.capabilities.canLive).toBe(false);
    expect(view.capabilities.canRefresh).toBe(false);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(
      await status(world.service.link(contextOf(CLIENT), CLIENT, 'client', INTERNAL_LINK)),
    ).toBe(404);
    // The studio door refuses a client, and the portal door refuses staff.
    expect(await status(world.service.link(contextOf(CLIENT), CLIENT, 'internal', LINK))).toBe(404);
    expect(await status(world.service.link(contextOf(STAFF), STAFF, 'client', LINK))).toBe(404);
  });

  it('lists a client only the links shared with clients, across its projects', async () => {
    const world = build();
    const view = await world.service.clientLinks(contextOf(CLIENT), CLIENT);
    expect(view.links.map((link) => link.id)).toEqual([LINK]);
    expect(await status(world.service.clientLinks(contextOf(STAFF), STAFF))).toBe(404);
  });

  it('answers the review service: the frame of a readable link, nothing otherwise', async () => {
    const world = build();
    await expect(world.access.resolveFrame(contextOf(CLIENT), CLIENT, FRAME)).resolves.toEqual({
      frameId: FRAME,
      organizationId: ORG,
      projectId: PROJECT,
      audience: 'client_visible',
      archived: false,
    });
    await expect(world.access.resolveFrame(contextOf(STAFF), STAFF, 'nope')).resolves.toBeNull();
  });
});

describe('FigmaService · a file larger than one link captures', () => {
  const url = `https://www.figma.com/design/${KEY}/Atlas`;

  it('lists every frame, captures the first MAX_CAPTURED_FRAMES and skips the rest', async () => {
    const world = build({ connected: true, outline: outlineOf(MAX_CAPTURED_FRAMES + 7) });
    await world.service.attach(contextOf(STAFF), STAFF, PROJECT, { url });
    const listed = world.inserted[0]!.frames;
    expect(listed).toHaveLength(MAX_CAPTURED_FRAMES + 7);
    expect(listed.filter((item) => item.placement.captured)).toHaveLength(MAX_CAPTURED_FRAMES);
  });

  it('says how much is captured and that the file is over the limit', async () => {
    const world = build();
    world.frames.push(
      ...Array.from({ length: MAX_CAPTURED_FRAMES + 1 }, (_, index) =>
        frameRow(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `2:${index}`, {
          snapshotStatus: index < 3 ? 'pending' : 'skipped',
        }),
      ),
    );
    const view = await world.service.link(contextOf(STAFF), STAFF, 'internal', LINK);
    expect(view.capture).toMatchObject({
      mode: 'whole_file',
      frameCount: MAX_CAPTURED_FRAMES + 2,
      ready: 1,
      pending: 3,
      skipped: MAX_CAPTURED_FRAMES - 2,
      overLimit: true,
    });
    expect(view.pages[0]).toMatchObject({ id: '0:1', readyCount: 1, selected: true });
  });
});

describe('FigmaService · Refresh from Figma', () => {
  it('adds new frames, updates the ones it has in place and marks the missing gone', async () => {
    const world = build({ connected: true, outline: outlineOf(2) });
    // Stored: 1:2 (still in Figma) and 9:9 (gone). Figma now has 1:2 and 1:3.
    world.frames.push(frameRow('00000000-0000-4000-8000-0000000000f9', '9:9'));
    await world.service.refresh(contextOf(STAFF), STAFF, LINK);
    const diff = world.diffs[0]!;
    expect(diff.inserts.map((item) => item.frame.nodeId)).toEqual(['1:3']);
    // The same row: the frame's comment threads stay on it.
    expect(diff.updates.map((item) => item.row.id)).toEqual([FRAME]);
    expect(diff.gone.map((row) => row.nodeId)).toEqual(['9:9']);
    expect(world.requested()).toBe(1);
    expect(world.audits).toContain('figma.link_refreshed');
  });

  it('holds a second refresh of the same link for a few minutes, server-side (review M2)', async () => {
    const world = build({ connected: true, outline: outlineOf(2) });
    const link = world.links.get(LINK)!;
    world.links.set(LINK, { ...link, syncedAt: new Date(NOW.getTime() - 60_000) });
    const refused = await world.service.refresh(contextOf(STAFF), STAFF, LINK).catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409 });
    expect(world.diffs).toHaveLength(0);
    expect(world.requested()).toBe(0);
    expect(world.audits).not.toContain('figma.link_refreshed');
  });

  it('is the team only', async () => {
    const world = build({ connected: true });
    expect(await status(world.service.refresh(contextOf(CLIENT), CLIENT, LINK))).toBe(404);
  });
});

describe('FigmaService · sharper render for zoom', () => {
  it('renders at the server-chosen scale once, then serves the stored render', async () => {
    const world = build({ connected: true });
    const first = await world.service.render(contextOf(STAFF), STAFF, 'internal', FRAME);
    expect(first.mimeType).toBe('image/png');
    await world.service.render(contextOf(STAFF), STAFF, 'internal', FRAME);
    expect(world.renderCalls).toEqual([MAX_RENDER_SCALE]);
    expect(world.audits).toContain('figma.snapshot_taken');
  });

  it('lets a client zoom a shared link on the team connection, under a limit', async () => {
    const world = build({ connected: true, rendersPerPerson: 1 });
    await world.service.render(contextOf(CLIENT), CLIENT, 'client', FRAME);
    expect(world.renderCalls).toHaveLength(1);
    // A second new render (another frame) is over the person's limit: 429, no Figma call.
    const second = '00000000-0000-4000-8000-0000000000f3';
    world.frames.push(frameRow(second, '1:9', { snapshotHash: 'b'.repeat(64) }));
    expect(await status(world.service.render(contextOf(CLIENT), CLIENT, 'client', second))).toBe(
      429,
    );
    expect(world.renderCalls).toHaveLength(1);
  });

  it('refuses a portal user every picture of a link not shared with clients', async () => {
    const world = build({ connected: true });
    const internal = '00000000-0000-4000-8000-0000000000f4';
    world.frames.push(frameRow(internal, '1:7', { linkId: INTERNAL_LINK }));
    for (const route of ['render', 'thumb', 'snapshot'] as const) {
      expect(
        await status(world.service[route](contextOf(CLIENT), CLIENT, 'client', internal)),
      ).toBe(404);
    }
    expect(world.renderCalls).toHaveLength(0);
  });

  it('answers 404 when the snapshot is already the sharpest Figma can render', async () => {
    const world = build({ connected: true });
    const huge = '00000000-0000-4000-8000-0000000000f5';
    world.frames.push(frameRow(huge, '1:8', { width: 16_000, height: 16_000 }));
    expect(await status(world.service.render(contextOf(STAFF), STAFF, 'internal', huge))).toBe(404);
  });
});
