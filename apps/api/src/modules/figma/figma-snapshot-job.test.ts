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
import { FigmaSnapshotJob, DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS } from './figma-snapshot-job.js';
import type { FigmaRepository } from './figma.repository.js';
import { FigmaRateLimitError, type FigmaRestClient } from './figma.rest.js';
import { figmaSnapshotObjectKey, figmaTokenBinding } from './figma.service.js';

/**
 * R4 slice 13 — the snapshot job against an in-memory repository and a fake Figma: the PNG is
 * stored under the frame's key with its SHA-256, a frame captured before at another size gets
 * "Frame changed", Figma's 429 hands the claims back, and a link whose creator has no token fails.
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function build(input: {
  frames: FigmaFrameRow[];
  connected?: boolean;
  nodeSize?: { width: number; height: number };
  rateLimited?: boolean;
}) {
  const frames = new Map(input.frames.map((row) => [row.id, { ...row }]));
  const link: FigmaLinkRow = {
    id: LINK,
    organizationId: ORG,
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
  };
  const connection: FigmaConnectionRow | undefined =
    input.connected === false
      ? undefined
      : {
          id: 'c',
          organizationId: ORG,
          membershipId: MEMBER,
          tokenCiphertext: CIPHER.encrypt('figd_secret', figmaTokenBinding(ORG, MEMBER)),
          tokenHint: 'cret',
          figmaUserHandle: 'lina',
          status: 'connected',
          createdAt: NOW,
          updatedAt: NOW,
        };
  const released: string[] = [];
  const repository = {
    organizationsWithPendingFrames: async () => [ORG],
    listPendingFrames: async () =>
      [...frames.values()].filter((f) => f.snapshotStatus === 'pending'),
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
    recordSnapshotFailure: async (_r: unknown, _c: unknown, f: FigmaFrameRow, final: boolean) => {
      const row = frames.get(f.id)!;
      row.snapshotAttempts += 1;
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
        sizeChanged: boolean;
      },
    ) => {
      Object.assign(frames.get(id)!, {
        snapshotStatus: 'ready',
        snapshotObjectKey: ready.objectKey,
        snapshotHash: ready.hash,
        width: ready.width,
        height: ready.height,
        sizeChanged: ready.sizeChanged,
        capturedAt: NOW,
      });
      return true;
    },
  } as unknown as FigmaRepository;
  const size = input.nodeSize ?? { width: 390, height: 844 };
  const rest = {
    nodes: async (_t: string, _k: string, ids: readonly string[]) => {
      if (input.rateLimited) throw new FigmaRateLimitError(60);
      return {
        name: 'Atlas',
        nodes: ids.map((nodeId) => ({ nodeId, name: 'Booking', ...size, pageName: null })),
      };
    },
    renderUrls: async (_t: string, _k: string, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `https://figma-alpha-api.s3.amazonaws.com/${id}.png`])),
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
  return { job, frames, stored, released };
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

  it('marks a frame captured before at another size as changed', async () => {
    const world = build({
      frames: [frame(F1, { capturedAt: new Date('2026-10-01T00:00:00Z') })],
      nodeSize: { width: 390, height: 900 },
    });
    await world.job.pass();
    expect(world.frames.get(F1)).toMatchObject({ height: 900, sizeChanged: true });
  });

  it('keeps the same size unchanged on a refresh', async () => {
    const world = build({ frames: [frame(F1, { capturedAt: new Date('2026-10-01T00:00:00Z') })] });
    await world.job.pass();
    expect(world.frames.get(F1)?.sizeChanged).toBe(false);
  });

  it('hands the claims back when Figma rate-limits, counting no attempt', async () => {
    const world = build({ frames: [frame(F1), frame(F2)], rateLimited: true });
    const report = await world.job.pass();
    expect(report.rateLimited).toBe(true);
    expect(world.released.sort()).toEqual([F1, F2]);
    expect(world.frames.get(F1)).toMatchObject({ snapshotStatus: 'pending', snapshotAttempts: 0 });
  });

  it('fails the frames of a link whose creator has no Figma token', async () => {
    const world = build({ frames: [frame(F1)], connected: false });
    const report = await world.job.pass();
    expect(report.failed).toBe(1);
    expect(world.frames.get(F1)?.snapshotStatus).toBe('failed');
  });

  it('refuses a snapshot key built from something that is not a UUID', () => {
    expect(() => figmaSnapshotObjectKey(ORG, '../x', F1)).toThrow();
  });
});
