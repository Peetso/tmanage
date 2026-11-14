import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  FigmaConnectionRow,
  FigmaFrameRow,
  FigmaLinkRow,
} from '../../common/database/schema.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import {
  DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS,
  FigmaSnapshotJob,
  figmaSnapshotJobEnabled,
} from './figma-snapshot-job.js';
import type { FigmaRepository } from './figma.repository.js';
import { FigmaAuthError, FigmaRateLimitError, type FigmaRestClient } from './figma.rest.js';
import { figmaSnapshotObjectKey, figmaTokenBinding } from './figma.service.js';

/**
 * R4 slice 13 (reworked 2026-11-10) — the snapshot job against an in-memory repository and a
 * fake Figma: the PNG is stored under the frame's key with its SHA-256, frames are rendered per
 * scale, Figma's 429 hands the claims back, and each failure records why (the team's screen says
 * it): no connection, no access, a frame Figma no longer has.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const LINK = '00000000-0000-4000-8000-0000000000d1';
const MEMBER = '00000000-0000-4000-8000-0000000000e1';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x51).toString('base64url')}`));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const NOW = new Date('2026-11-01T10:00:00Z');

function frame(id: string, over: Partial<FigmaFrameRow> = {}): FigmaFrameRow {
  return {
    id,
    organizationId: ORG,
    linkId: LINK,
    nodeId: `1:${id.slice(-1)}`,
    name: 'Booking',
    width: 390,
    height: 844,
    snapshotObjectKey: null,
    snapshotHash: null,
    snapshotStatus: 'pending',
    snapshotAttempts: 0,
    claimedAt: null,
    capturedAt: null,
    sizeChanged: false,
    sortOrder: 0,
    pageId: '0:1',
    pageName: 'Mobile',
    sectionName: null,
    posX: 0,
    posY: 0,
    captureRank: 0,
    goneAt: null,
    hasThumb: false,
    snapshotError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function build(input: {
  frames: FigmaFrameRow[];
  connected?: boolean;
  rateLimited?: boolean;
  /** Figma answers no render for these node ids (the frame is gone). */
  missing?: readonly string[];
  /** Figma refuses the token with this status. */
  refused?: number;
  /** Workspaces with pending frames (default: the one). */
  organizations?: readonly string[];
  /** Workspaces whose token Figma answers with 429. */
  limitedOrganizations?: ReadonlySet<string>;
}) {
  const frames = new Map(input.frames.map((row) => [row.id, { ...row }]));
  let current = ORG;
  const renderCalls: string[] = [];
  const link: FigmaLinkRow = {
    id: LINK,
    get organizationId() {
      return current;
    },
    projectId: PROJECT,
    fileKey: 'ZdUCRiqBiT7s3u08HA28RO',
    fileName: 'Atlas',
    url: 'https://www.figma.com/design/ZdUCRiqBiT7s3u08HA28RO',
    attachedToType: null,
    attachedToId: null,
    audience: 'internal',
    createdByMembershipId: MEMBER,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    captureMode: 'whole_file',
    focusNodeId: null,
    outlineJson: null,
    pageFilterJson: null,
    syncedAt: NOW,
  };
  const connection: FigmaConnectionRow | undefined =
    input.connected === false
      ? undefined
      : {
          id: 'c',
          organizationId: ORG,
          membershipId: MEMBER,
          get tokenCiphertext() {
            return CIPHER.encrypt('figd_secret', figmaTokenBinding(current, MEMBER));
          },
          tokenHint: 'cret',
          figmaUserHandle: 'lina',
          status: 'connected',
          createdAt: NOW,
          updatedAt: NOW,
        };
  const released: string[] = [];
  const repository = {
    organizationsWithPendingFrames: async () => input.organizations ?? [ORG],
    listPendingFrames: async (_db: unknown, context: { organizationId: string }) => {
      current = context.organizationId;
      return [...frames.values()].filter(
        (f) => f.snapshotStatus === 'pending' && f.organizationId === context.organizationId,
      );
    },
    claimFrame: async (_r: unknown, _c: unknown, f: FigmaFrameRow) => {
      frames.get(f.id)!.claimedAt = NOW;
      return true;
    },
    findLinks: async () => [link],
    findConnection: async () => connection,
    markConnectionError: async () => undefined,
    releaseFrame: async (_r: unknown, _c: unknown, id: string) => {
      released.push(id);
      frames.get(id)!.claimedAt = null;
    },
    recordSnapshotFailure: async (
      _r: unknown,
      _c: unknown,
      f: FigmaFrameRow,
      final: boolean,
      _now: Date,
      reason: string,
    ) => {
      const row = frames.get(f.id)!;
      row.snapshotAttempts += 1;
      row.snapshotError = reason;
      if (final || row.snapshotAttempts >= 3) row.snapshotStatus = 'failed';
    },
    markSnapshotReady: async (
      _r: unknown,
      _c: unknown,
      id: string,
      ready: {
        objectKey: string;
        hash: string;
        width: number;
        height: number;
        hasThumb: boolean;
      },
    ) => {
      Object.assign(frames.get(id)!, {
        snapshotStatus: 'ready',
        snapshotObjectKey: ready.objectKey,
        snapshotHash: ready.hash,
        width: ready.width,
        height: ready.height,
        hasThumb: ready.hasThumb,
        capturedAt: NOW,
      });
      return true;
    },
  } as unknown as FigmaRepository;
  const scales: number[] = [];
  const rest = {
    renderUrls: async (_t: string, _k: string, ids: readonly string[], scale: number) => {
      renderCalls.push(current);
      if (input.rateLimited || input.limitedOrganizations?.has(current)) {
        throw new FigmaRateLimitError(60);
      }
      if (input.refused) throw new FigmaAuthError(input.refused);
      scales.push(scale);
      return new Map(
        ids.map((id) => [
          id,
          input.missing?.includes(id) ? null : `https://figma-alpha-api.s3.amazonaws.com/${id}.png`,
        ]),
      );
    },
    download: async () => PNG,
  } as unknown as FigmaRestClient;
  const stored = new Map<string, Uint8Array>();
  const store = {
    putDerivative: async ({ objectKey, body }: { objectKey: string; body: Uint8Array }) => {
      stored.set(objectKey, body);
      return { sizeBytes: body.length };
    },
  } as unknown as ObjectStore;
  const runner = {};
  const database = {
    bootstrapRead: (_o: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
    read: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
    transaction: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
  } as unknown as TenantDatabase;
  const job = new FigmaSnapshotJob(
    database,
    store,
    rest,
    CIPHER,
    null,
    false,
    { ...DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS, log: () => undefined },
    repository,
    () => NOW,
  );
  return { job, frames, stored, released, scales, renderCalls };
}

const F1 = '00000000-0000-4000-8000-0000000000f1';
const F2 = '00000000-0000-4000-8000-0000000000f2';

describe('FigmaSnapshotJob', () => {
  it('stores the PNG under the frame key with its SHA-256; a first capture is not "changed"', async () => {
    const world = build({ frames: [frame(F1)] });
    const report = await world.job.pass();
    expect(report).toMatchObject({ ready: 1, failed: 0, rateLimited: false });
    const key = figmaSnapshotObjectKey(ORG, LINK, F1);
    expect(world.stored.get(key)).toBe(PNG);
    expect(world.frames.get(F1)).toMatchObject({
      snapshotStatus: 'ready',
      snapshotObjectKey: key,
      snapshotHash: createHash('sha256').update(PNG).digest('hex'),
      sizeChanged: false,
    });
  });

  it('renders a small frame at 2x and a tall one lower, one images call per scale', async () => {
    const world = build({ frames: [frame(F1), frame(F2, { width: 1440, height: 8192 })] });
    const report = await world.job.pass();
    expect(report.ready).toBe(2);
    expect(world.scales.sort()).toEqual([0.5, 2]);
  });

  it('hands the claims back when Figma rate-limits, counting no attempt', async () => {
    const world = build({ frames: [frame(F1), frame(F2)], rateLimited: true });
    const report = await world.job.pass();
    expect(report.rateLimited).toBe(true);
    expect(world.released.sort()).toEqual([F1, F2]);
    expect(world.frames.get(F1)).toMatchObject({ snapshotStatus: 'pending', snapshotAttempts: 0 });
  });

  it("one workspace's 429 does not stop the others; it waits alone, and passes rotate", async () => {
    // Security review M1 (2026-11-14).
    const ORG_B = '00000000-0000-4000-8000-0000000000b2';
    const world = build({
      frames: [frame(F1), frame(F2, { organizationId: ORG_B })],
      organizations: [ORG, ORG_B],
      limitedOrganizations: new Set([ORG]),
    });
    const first = await world.job.pass();
    expect(first).toMatchObject({ ready: 1, rateLimited: true });
    expect(world.frames.get(F2)).toMatchObject({ snapshotStatus: 'ready' });
    expect(world.frames.get(F1)).toMatchObject({ snapshotStatus: 'pending', snapshotAttempts: 0 });
    expect(world.released).toEqual([F1]);
    // The refused workspace is set aside: the next pass does not call Figma for it again.
    const second = await world.job.pass();
    expect(second.rateLimited).toBe(true);
    expect(world.renderCalls.filter((org) => org === ORG)).toHaveLength(1);
  });

  it('the first workspace of a pass rotates', async () => {
    const ORG_B = '00000000-0000-4000-8000-0000000000b2';
    const world = build({
      frames: [frame(F1), frame(F2, { organizationId: ORG_B })],
      organizations: [ORG, ORG_B],
    });
    await world.job.pass();
    for (const id of [F1, F2]) {
      Object.assign(world.frames.get(id)!, { snapshotStatus: 'pending', claimedAt: null });
    }
    await world.job.pass();
    expect(world.renderCalls).toEqual([ORG, ORG_B, ORG_B, ORG]);
  });

  it('fails the frames of a link whose creator has no Figma token', async () => {
    const world = build({ frames: [frame(F1)], connected: false });
    const report = await world.job.pass();
    expect(report.failed).toBe(1);
    expect(world.frames.get(F1)).toMatchObject({
      snapshotStatus: 'failed',
      snapshotError: 'no_connection',
    });
  });

  it('records why: no access to the file, or a frame Figma no longer has', async () => {
    const refused = build({ frames: [frame(F1)], refused: 403 });
    await refused.job.pass();
    expect(refused.frames.get(F1)).toMatchObject({
      snapshotStatus: 'failed',
      snapshotError: 'no_access',
    });
    const gone = build({ frames: [frame(F1), frame(F2)], missing: ['1:2'] });
    const report = await gone.job.pass();
    expect(report).toMatchObject({ ready: 1, failed: 1 });
    expect(gone.frames.get(F2)).toMatchObject({
      snapshotStatus: 'failed',
      snapshotError: 'not_found',
    });
  });

  it('runs in the one live process unless turned off, and in suites never', () => {
    expect(figmaSnapshotJobEnabled({})).toBe(false);
    expect(figmaSnapshotJobEnabled({ FIGMA_SNAPSHOT_INPROCESS: '1' })).toBe(true);
    expect(figmaSnapshotJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(figmaSnapshotJobEnabled({ WORKER_INPROCESS: '1', FIGMA_SNAPSHOT_INPROCESS: '0' })).toBe(
      false,
    );
  });

  it('refuses a snapshot key built from something that is not a UUID', () => {
    expect(() => figmaSnapshotObjectKey(ORG, '../x', F1)).toThrow();
  });
});
