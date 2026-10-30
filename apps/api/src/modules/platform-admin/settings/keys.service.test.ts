import { describe, expect, it, vi } from 'vitest';
import type { FieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { KeysStore, StoredRotation } from './keys.repository.js';
import { PlatformKeysService, keysView } from './keys.service.js';

/** 56-02 Keys: status from env + ledger (never a value); rotate queues onto the newest key. */

const ring = (...ids: string[]): FieldCipherKeyring => ({
  active: { id: ids[ids.length - 1] as string, key: Buffer.alloc(32, 7) },
  byId: new Map(ids.map((id) => [id, Buffer.alloc(32, Number(id))])),
});
const row = (over: Partial<StoredRotation>): StoredRotation => ({
  id: 'r',
  purpose: 'storage_token',
  fromKeyId: '1',
  toKeyId: '2',
  status: 'running',
  rowsTotal: 5120,
  rowsDone: 3500,
  rowsSkipped: 0,
  rowsFailed: 0,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor = (preset: NonNullable<PlatformAdminActor['preset']>): PlatformAdminActor => ({
  account: {
    userId: 'u',
    email: 'p@example.com',
    displayName: 'P',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
  preset,
});

describe('keysView', () => {
  it('reports ids, progress and the quarterly due date without any key bytes', () => {
    const view = keysView({ keyring: ring('1', '2'), mfaFallback: null, sessionOverlap: false }, [
      row({}),
      row({ id: 'o', status: 'done', toKeyId: '1', finishedAt: new Date('2026-10-12T00:00:00Z') }),
    ]);
    const storage = view.purposes.find((p) => p.purpose === 'storage_token');
    expect(view.keyIds).toEqual(['1', '2']);
    expect(storage).toMatchObject({ activeKeyId: '2', keysInRing: 2, rowsOnOldKey: 1620 });
    expect(view.rotation?.rowsProcessed).toBe(3500);
    expect(view.nextRotationDueAt).toBe('2027-01-12T00:00:00.000Z');
    expect(JSON.stringify(view)).not.toContain('BwcH');
  });

  it('lists the reporter e-mail as rotatable (56-17 follow-up)', () => {
    const view = keysView({ keyring: ring('1'), mfaFallback: null, sessionOverlap: false }, []);
    expect(view.purposes.find((p) => p.purpose === 'reporter_email')?.rotatable).toBe(true);
  });
});

describe('PlatformKeysService.rotate', () => {
  it('queues onto the newest key for a super admin and refuses everyone else', async () => {
    const store: KeysStore = { rotations: vi.fn(async () => []), queue: vi.fn(async () => true) };
    const service = new PlatformKeysService(store, {
      keyring: ring('1', '2'),
      mfaFallback: null,
      sessionOverlap: false,
    });
    await service.rotate(actor('super_admin'), { purpose: 'storage_token' }, ctx);
    expect(store.queue).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'storage_token', fromKeyId: '1', toKeyId: '2' }),
      expect.objectContaining({ action: 'platform.key_rotation_started' }),
    );
    await expect(
      service.rotate(actor('support'), { purpose: 'storage_token' }, ctx),
    ).rejects.toMatchObject({ status: 403 });
  });
});
