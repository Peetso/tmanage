import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
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
import { FigmaAuthError, type FigmaRestClient } from './figma.rest.js';
import { FigmaService, figmaTokenBinding } from './figma.service.js';
import { FigmaOAuthRefusedError } from './figma-oauth.js';

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
  };
}

function build(
  options: {
    connected?: boolean;
    figmaRefuses?: boolean;
    oauth?: boolean;
    exchange?: () => Promise<{ readonly accessToken: string }>;
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
  const frames: FigmaFrameRow[] = [
    {
      id: FRAME,
      organizationId: ORG,
      linkId: LINK,
      nodeId: '1:2',
      name: 'Booking — Step 2',
      width: 390,
      height: 844,
      snapshotObjectKey: `tenant/${ORG}/figma/${LINK}/${FRAME}`,
      snapshotHash: 'a'.repeat(64),
      snapshotStatus: 'ready',
      snapshotAttempts: 0,
      claimedAt: null,
      capturedAt: NOW,
      sizeChanged: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const inserted: InsertLinkInput[] = [];
  const audits: string[] = [];
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
    store: {} as ObjectStore,
    snapshots: { request: () => (requested += 1) },
    repository,
    projects,
    threads,
    now: () => NOW,
    ...(options.oauth
      ? {
          oauth: { clientId: 'figma-client', clientSecret: 'figma-secret' },
          apiPublicUrl: 'https://api.example.test/',
          exchange: options.exchange ?? (async () => ({ accessToken: 'figu_oauth_token_9876' })),
        }
      : {}),
  });
  const access = new FigmaAccess(database, repository, projects);
  return { service, access, connections, inserted, audits, requested: () => requested };
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

  it('attaches the linked frame, audits and queues the snapshots', async () => {
    const world = build({ connected: true });
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
      frames: [{ nodeId: '1:2', width: 390, height: 844 }],
    });
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
    const many = Array.from({ length: 21 }, (_, i) => `1:${i + 1}`);
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
