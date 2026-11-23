import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import { pngCodec } from '../files/preview-generators/codecs.js';
import { parsePhotoSize, parsePhotoUpload } from './profile-photo.controller.js';
import type { PhotoCandidateRow, ProfilePhotoRepository } from './profile-photo.repository.js';
import { ProfilePhotoService } from './profile-photo.service.js';

const ORG = uuidv7();
const ME = uuidv7();
const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;
const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function principal(
  role: string,
  kind: 'internal' | 'client' = 'internal',
  client: string | null = null,
) {
  return {
    userId: ME,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'm-me',
    membershipStatus: 'active',
    projectIds: [],
    hasOrgWideScope: true,
    clientOrganizationId: client,
  } as unknown as Principal;
}

function png(side: number): Buffer {
  const { PNG } = pngCodec();
  const image = new PNG({ width: side, height: side });
  image.data.fill(200);
  return PNG.sync.write(image);
}

const SHA = 'a'.repeat(64);

function harness(candidates: PhotoCandidateRow[] = [], scanner?: MalwareScanner) {
  const stored = new Map<string, { sha256: string; updatedAt: Date }>();
  const removals = new Map<string, string>();
  const audits: { action: string; objectId: string; metadata?: unknown }[] = [];
  const repo = {
    findOwn: async (_r: unknown, userId: string) => stored.get(userId) ?? null,
    findImage: async (_r: unknown, userId: string) =>
      stored.has(userId) || candidates.some((c) => c.userId === userId)
        ? { sha256: SHA, imageBase64: Buffer.from('img').toString('base64') }
        : null,
    upsert: async (_r: unknown, userId: string, input: { sha256: string }, now: Date) => {
      stored.set(userId, { sha256: input.sha256, updatedAt: now });
    },
    remove: async (_r: unknown, userId: string) => void stored.delete(userId),
    findRemoval: async (_r: unknown, _c: unknown, userId: string) => removals.get(userId) ?? null,
    listRemovals: async () => removals,
    upsertRemoval: async (_r: unknown, _c: unknown, userId: string, sha: string) =>
      void removals.set(userId, sha),
    listCandidates: async (_r: unknown, _c: unknown, userId?: string) =>
      candidates.filter((c) => userId === undefined || c.userId === userId),
  } as unknown as ProfilePhotoRepository;
  const audit = {
    record: async (_r: unknown, _c: unknown, input: { action: string; objectId: string }) =>
      void audits.push(input),
  } as unknown as AuditService;
  const service = new ProfilePhotoService(database, repo, audit, scanner);
  return { service, stored, removals, audits };
}

const member = (userId: string, sha = SHA): PhotoCandidateRow => ({
  userId,
  sha256: sha,
  internalMember: true,
  clientOrganizationIds: [],
  membershipIds: [`m-${userId}`],
});
const contact = (userId: string, client: string): PhotoCandidateRow => ({
  userId,
  sha256: SHA,
  internalMember: false,
  clientOrganizationIds: [client],
  membershipIds: [`cm-${userId}`],
});

describe('ProfilePhotoService — own photo', () => {
  it('stores only for the principal, audits set and removed, and answers the view', async () => {
    const h = harness();
    const view = await h.service.setMine(context, principal('member'), {
      mimeType: 'image/png',
      bytes: png(128),
    });
    expect(view.photo?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(view.removedHere).toBe(false);
    expect([...h.stored.keys()]).toEqual([ME]);
    expect(await h.service.removeMine(context, principal('member'))).toEqual({
      photo: null,
      removedHere: false,
    });
    expect(h.audits.map((a) => [a.action, a.objectId, a.metadata])).toEqual([
      ['member.photo_changed', 'm-me', { change: 'set' }],
      ['member.photo_changed', 'm-me', { change: 'removed' }],
    ]);
  });

  it('refuses a file that is not a photo with a plain sentence, and stores nothing', async () => {
    const h = harness();
    await expect(
      h.service.setMine(context, principal('member'), {
        mimeType: 'image/png',
        bytes: Buffer.from('<svg onload=alert(1)>'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.stored.size).toBe(0);
  });

  it('refuses an infected file (422) and an unreachable engine (503); stores nothing', async () => {
    const infected = {
      name: 'stub',
      kind: 'engine',
      probe: async () => undefined,
      scan: async () => ({ verdict: 'infected' as const }),
    } as MalwareScanner;
    const down = {
      ...infected,
      scan: async () => {
        throw new ScannerUnavailableError('down');
      },
    } as MalwareScanner;
    for (const [scanner, status] of [
      [infected, 422],
      [down, 503],
    ] as const) {
      const h = harness([], scanner);
      await expect(
        h.service.setMine(context, principal('member'), { mimeType: 'image/png', bytes: png(80) }),
      ).rejects.toMatchObject({ status });
      expect(h.stored.size).toBe(0);
    }
  });
});

describe('ProfilePhotoService — who sees whose photo', () => {
  const people = [member('u-staff'), contact('u-acme', 'acme'), contact('u-globex', 'globex')];

  it('an internal member sees members and every client contact', async () => {
    const { service } = harness(people);
    const view = await service.listPeople(context, principal('member'));
    expect(view.photos.map((p) => p.userId)).toEqual(['u-acme', 'u-globex', 'u-staff']);
  });

  it("a client contact never sees another client's contacts (list and image)", async () => {
    const { service } = harness(people);
    const acme = principal('client_viewer', 'client', 'acme');
    const view = await service.listPeople(context, acme);
    // The list gives a client their own contacts only, never the staff roster.
    expect(view.photos.map((p) => p.userId)).toEqual(['u-acme']);
    await expect(service.personImage(context, acme, 'u-staff', 64)).resolves.toBeDefined();
    await expect(service.personImage(context, acme, 'u-globex', 64)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a person outside the company is the same 404 as no photo', async () => {
    const { service } = harness(people);
    await expect(
      service.personImage(context, principal('member'), 'u-stranger', 64),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('ProfilePhotoService — removal by an owner or admin', () => {
  it('hides that exact photo in this company only, audited once; a member is refused', async () => {
    const h = harness([member('u-x')]);
    await expect(h.service.removeMember(context, principal('member'), 'u-x')).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    await h.service.removeMember(context, principal('owner'), 'u-x');
    await h.service.removeMember(context, principal('owner'), 'u-x');
    expect(h.removals.get('u-x')).toBe(SHA);
    expect(h.audits.map((a) => a.action)).toEqual(['member.photo_removed']);
    const view = await h.service.listPeople(context, principal('member'));
    expect(view.photos).toEqual([]);
  });

  it('a different photo uploaded later shows again', async () => {
    const h = harness([member('u-x', 'b'.repeat(64))]);
    h.removals.set('u-x', SHA);
    const view = await h.service.listPeople(context, principal('member'));
    expect(view.photos.map((p) => p.userId)).toEqual(['u-x']);
  });
});

describe('profile photo route parsing', () => {
  it('takes base64 within the cap and a size of 64 or 256 only', () => {
    expect(parsePhotoUpload({ mimeType: 'image/png', dataBase64: 'aGk=' }).bytes.length).toBe(2);
    expect(() => parsePhotoUpload({ mimeType: 'image/png', dataBase64: 'not base64!' })).toThrow();
    expect(() =>
      parsePhotoUpload({ mimeType: 'image/png', dataBase64: 'A'.repeat(800_000) }),
    ).toThrow();
    expect(parsePhotoSize(undefined)).toBe(64);
    expect(parsePhotoSize('256')).toBe(256);
    expect(() => parsePhotoSize('1024')).toThrow();
  });
});
