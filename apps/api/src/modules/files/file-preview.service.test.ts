import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FakeObjectStore } from '@tmanage/storage';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DeliverableVersionsRepository } from '../approvals/deliverable-versions.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import type { ClientFileReachRepository } from './client-file-reach.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileClientRelation } from './file-client-relation.js';
import { FileDownloadService, parseByteRange } from './file-download.service.js';
import {
  FilePreviewService,
  ViewAuditDebounce,
  isInlineDerivative,
  manifestStatusFor,
  viewerKindFor,
} from './file-preview.service.js';
import type { FilePreview, FilePreviewsRepository } from './file-previews.repository.js';

/**
 * R4 slice 4 — the viewer manifest, derivative content, Range/inline on the original, and the
 * client's reach to a published deliverable file. Fakes with the real `authorize()`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';
const ASSET = '00000000-0000-4000-8000-0000000000d1';
const V2_ASSET = '00000000-0000-4000-8000-0000000000d2';
const VERSION = '00000000-0000-4000-8000-0000000000f1';
const DELIVERABLE = '00000000-0000-4000-8000-000000000101';
const DELIVERABLE_VERSION = '00000000-0000-4000-8000-000000000102';
const CLIENT_ORG = '00000000-0000-4000-8000-000000000201';
const PREVIEW_ID = '00000000-0000-4000-8000-000000000301';
const context = { organizationId: ORG, membershipId: 'm', userId: 'u' } as unknown as TenantContext;

const staff: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: true,
};

function client(role: Principal['role'] = 'client_reviewer', projectIds = [PROJECT]): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c2',
    organizationId: ORG,
    kind: 'client',
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e2',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds,
    hasOrgWideScope: false,
  };
}

function asset(overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id: ASSET,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    ownerUserId: staff.userId,
    name: 'poster.png',
    purpose: 'deliverable',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    deletedAt: null,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  } as unknown as FileAssetRow;
}

function version(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: VERSION,
    scanVerdict: 'clean',
    trustZone: 'private',
    detectedMimeType: 'image/png',
    objectKey: 'tenant/org/original/1',
    sizeBytes: 10,
    ...overrides,
  } as unknown as FileVersionRow;
}

function preview(overrides: Partial<FilePreview> = {}): FilePreview {
  return {
    id: PREVIEW_ID,
    organizationId: ORG,
    fileAssetId: ASSET,
    fileVersionId: VERSION,
    kind: 'preview',
    pageNo: 0,
    status: 'ready',
    objectKey: 'tenant/org/derivative/v/p',
    mimeType: 'image/webp',
    sizeBytes: 4,
    width: 2048,
    height: 1024,
    meta: null,
    errorCode: null,
    attempts: 0,
    claimedAt: null,
    ...overrides,
  } as unknown as FilePreview;
}

interface World {
  readonly asset?: FileAssetRow;
  readonly version?: FileVersionRow | null;
  readonly previews?: readonly FilePreview[];
  /** The deliverable version that names ASSET, published (projection exists). */
  readonly published?: { projectId: string } | null;
  readonly deliverablePublished?: boolean;
  readonly chain?: readonly FileAssetRow[];
  readonly archived?: boolean;
}

function build(world: World = {}) {
  const theAsset = world.asset ?? asset();
  const theVersion = world.version === undefined ? version() : world.version;
  const rows = [...(world.previews ?? [])];
  const denials: string[] = [];
  const allowed: { action: string; metadata: Record<string, unknown> }[] = [];
  const store = new FakeObjectStore(() => 0);
  store.objects.set(`private/${version().objectKey}`, Buffer.from('0123456789'));
  store.objects.set(`derived/${preview().objectKey}`, Buffer.from('webp'));
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const byId = new Map<string, FileAssetRow>([[theAsset.id, theAsset]]);
  for (const member of world.chain ?? []) byId.set(member.id, member);
  const assets = {
    findWithLatestVersion: async (_r: unknown, _c: unknown, id: string) =>
      id === theAsset.id ? { asset: theAsset, version: theVersion } : null,
    findById: async (_r: unknown, _c: unknown, id: string) => byId.get(id) ?? null,
  } as unknown as FileAssetsRepository;
  const projects = {
    findById: async () => ({ id: PROJECT, archivedAt: world.archived ? new Date() : null }),
  } as unknown as ProjectsRepository;
  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      input: { action: string; metadata: Record<string, unknown> },
    ) => {
      allowed.push({ action: input.action, metadata: input.metadata });
      return {};
    },
    recordDenial: async (_c: unknown, _a: unknown, input: { auditCode: string }) => {
      denials.push(input.auditCode);
      return true;
    },
  } as unknown as AuditService;
  const reachReads = {
    publishedVersionNaming: async (_r: unknown, _c: unknown, id: string) =>
      id === ASSET && world.published
        ? { deliverableVersionId: DELIVERABLE_VERSION, projectId: world.published.projectId }
        : null,
    deliverableIsPublished: async () => world.deliverablePublished === true,
    chainSiblings: async (_r: unknown, _c: unknown, id: string) =>
      (world.chain ?? [])
        .filter((member) => member.id !== id)
        .concat(id === theAsset.id ? [] : [theAsset]),
  } as unknown as ClientFileReachRepository;
  const relation = new FileClientRelation({} as ClientRequestsRepository, reachReads);
  const downloads = new FileDownloadService(
    database,
    assets,
    projects,
    {} as ClientRequestsRepository,
    store,
    audit,
    undefined,
    { findByKey: async () => undefined } as unknown as OrgSettingsRepository,
    relation,
  );
  const previewsRepo = {
    listForVersion: async (_r: unknown, _c: unknown, id: string) =>
      rows.filter((row) => row.fileVersionId === id),
    findById: async (_r: unknown, _c: unknown, id: string) =>
      rows.find((row) => row.id === id) ?? null,
    resetFailed: async () => {
      let n = 0;
      for (const [i, row] of rows.entries()) {
        if (row.status === 'failed') {
          rows[i] = { ...row, status: 'pending' } as FilePreview;
          n += 1;
        }
      }
      return n;
    },
  } as unknown as FilePreviewsRepository;
  const chainLinks = (world.chain ?? []).filter((member) => member.id !== ASSET);
  const versionsRepo = {
    findInvolving: async () =>
      chainLinks.length > 0 ? { rootFileAssetId: ASSET, fileAssetId: chainLinks[0]?.id } : null,
    listForRoot: async () =>
      chainLinks.map((member, index) => ({
        fileAssetId: member.id,
        versionNo: index + 2,
        createdAt: new Date('2026-10-02T10:00:00Z'),
      })),
  } as unknown as AttachmentVersionsRepository;
  const deliverableVersions = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === DELIVERABLE_VERSION
        ? { id, deliverableId: DELIVERABLE, fileAssetId: ASSET, projectId: PROJECT }
        : null,
  } as unknown as DeliverableVersionsRepository;
  let requested = 0;
  const service = new FilePreviewService(
    database,
    downloads,
    assets,
    store,
    audit,
    previewsRepo,
    { request: () => (requested += 1) },
    relation,
    versionsRepo,
    deliverableVersions,
    new ViewAuditDebounce(),
    () => new Date('2026-11-01T10:00:00Z'),
  );
  return { service, downloads, store, denials, allowed, rows, requested: () => requested };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

const input = { orgSlug: 'atlas', fileAssetId: ASSET };

describe('client reach to a deliverable file (SPEC §3.4)', () => {
  it('reaches a published deliverable version file, even one uploaded as internal', async () => {
    const t = build({ published: { projectId: PROJECT } });
    const manifest = await t.service.manifest(context, client(), 'client', input);
    expect(manifest.status).toBe('pending');
    expect(manifest.file.id).toBe(ASSET);
    const download = await t.downloads.downloadForClient(context, client(), ASSET);
    expect(await drain(download.stream)).toBe('0123456789');
  });

  it('refuses an unpublished deliverable with the one 404', async () => {
    const t = build({ published: null });
    expect((await refusal(t.service.manifest(context, client(), 'client', input))).status).toBe(
      404,
    );
    expect((await refusal(t.downloads.downloadForClient(context, client(), ASSET))).status).toBe(
      404,
    );
    expect(t.denials).toEqual(['deliverable_not_published', 'deliverable_not_published']);
  });

  it('refuses a published version that names the file from another project', async () => {
    const t = build({ published: { projectId: OTHER_PROJECT } });
    expect((await refusal(t.downloads.downloadForClient(context, client(), ASSET))).status).toBe(
      404,
    );
  });

  it('refuses a client whose project list does not include the project', async () => {
    const t = build({ published: { projectId: PROJECT } });
    const outsider = client('client_reviewer', [OTHER_PROJECT]);
    expect((await refusal(t.downloads.downloadForClient(context, outsider, ASSET))).status).toBe(
      404,
    );
  });

  it('reaches a client-audience deliverable file of a published deliverable, for its own organization only', async () => {
    const own = asset({
      objectId: DELIVERABLE,
      audience: 'client_visible',
      clientOrganizationId: CLIENT_ORG,
    });
    const t = build({ asset: own, deliverablePublished: true });
    await expect(t.service.manifest(context, client(), 'client', input)).resolves.toBeTruthy();

    const sibling = asset({
      objectId: DELIVERABLE,
      audience: 'client_visible',
      clientOrganizationId: '00000000-0000-4000-8000-000000000299',
    });
    const s = build({ asset: sibling, deliverablePublished: true });
    expect((await refusal(s.service.manifest(context, client(), 'client', input))).status).toBe(
      404,
    );
  });

  it('reaches a client-visible later version through the chain, never an internal one', async () => {
    const later = asset({ id: V2_ASSET, audience: 'client_visible', name: 'poster v2.png' });
    const t = build({ asset: later, chain: [asset()], published: { projectId: PROJECT } });
    // The fake publishes ASSET (version 1); V2 is reached through the chain.
    const manifest = await t.service.manifest(context, client(), 'client', {
      orgSlug: 'atlas',
      fileAssetId: V2_ASSET,
    });
    expect(manifest.file.id).toBe(V2_ASSET);

    const internalLater = asset({ id: V2_ASSET, audience: 'internal' });
    const u = build({ asset: internalLater, chain: [asset()], published: { projectId: PROJECT } });
    expect(
      (
        await refusal(
          u.service.manifest(context, client(), 'client', {
            orgSlug: 'atlas',
            fileAssetId: V2_ASSET,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('keeps the studio door for staff and the portal door for clients', async () => {
    const t = build();
    expect((await refusal(t.service.manifest(context, staff, 'client', input))).status).toBe(403);
    expect((await refusal(t.service.manifest(context, client(), 'internal', input))).status).toBe(
      403,
    );
  });
});

describe('Range and inline on the original', () => {
  it('parses one range inside the size, and ignores the rest', () => {
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('bytes=4-999', 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=10-12', 10)).toBeNull();
    expect(parseByteRange('bytes=5-2', 10)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseByteRange('items=0-1', 10)).toBeNull();
    expect(parseByteRange('bytes=-', 10)).toBeNull();
    expect(parseByteRange('bytes=-0', 10)).toBeNull();
    expect(parseByteRange(undefined, 10)).toBeNull();
  });

  it('streams just the range from the store and audits the first request only', async () => {
    const t = build({ version: version({ detectedMimeType: 'video/mp4' }) });
    const first = await t.downloads.download(context, staff, ASSET, { range: 'bytes=0-3' });
    expect(first.range).toEqual({ start: 0, end: 3 });
    expect(await drain(first.stream)).toBe('0123');
    const seek = await t.downloads.download(context, staff, ASSET, { range: 'bytes=6-' });
    expect(seek.range).toEqual({ start: 6, end: 9 });
    expect(await drain(seek.stream)).toBe('6789');
    expect(t.allowed.filter((row) => row.action === 'file_asset.downloaded')).toHaveLength(1);
  });

  it('sends the whole file for an unsatisfiable range', async () => {
    const t = build();
    const download = await t.downloads.download(context, staff, ASSET, { range: 'bytes=50-60' });
    expect(download.range).toBeUndefined();
    expect(await drain(download.stream)).toBe('0123456789');
  });

  it('is inline only for video, audio and GIF originals asked inline', async () => {
    for (const [mime, expected] of [
      ['video/mp4', 'inline'],
      ['audio/mpeg', 'inline'],
      ['image/gif', 'inline'],
      ['application/pdf', 'attachment'],
      ['image/svg+xml', 'attachment'],
      ['image/png', 'attachment'],
    ] as const) {
      const t = build({ version: version({ detectedMimeType: mime }) });
      const download = await t.downloads.download(context, staff, ASSET, { inline: true });
      expect(download.disposition, mime).toBe(expected);
    }
    const t = build({ version: version({ detectedMimeType: 'video/mp4' }) });
    expect((await t.downloads.download(context, staff, ASSET)).disposition).toBe('attachment');
  });
});

describe('the manifest', () => {
  it('maps detected types to viewer kinds', () => {
    expect(viewerKindFor('image/png')).toBe('image');
    expect(viewerKindFor('image/heic')).toBe('image');
    expect(viewerKindFor('image/svg+xml')).toBe('svg');
    expect(viewerKindFor('image/vnd.adobe.photoshop')).toBe('psd');
    expect(viewerKindFor('application/pdf')).toBe('pdf');
    expect(viewerKindFor('video/quicktime')).toBe('video');
    expect(viewerKindFor('audio/flac')).toBe('audio');
    expect(viewerKindFor('application/zip')).toBe('zip');
    expect(viewerKindFor('text/csv')).toBe('text');
    expect(
      viewerKindFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('office_docx');
    expect(
      viewerKindFor('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe('office_pptx');
    expect(viewerKindFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'office_xlsx',
    );
    expect(viewerKindFor('application/postscript')).toBe('unsupported');
    expect(viewerKindFor(null)).toBe('unsupported');
  });

  it('reports a status per kind and derivative state', () => {
    const base = { access: 'servable' as const, planned: true, rows: [] as FilePreview[] };
    // The browser renders these from the original.
    expect(
      manifestStatusFor({ ...base, kind: 'pdf', mimeType: 'application/pdf', planned: false }),
    ).toBe('ready');
    expect(
      manifestStatusFor({ ...base, kind: 'video', mimeType: 'video/mp4', planned: false }),
    ).toBe('ready');
    expect(manifestStatusFor({ ...base, kind: 'image', mimeType: 'image/gif' })).toBe('ready');
    // Nothing generates this type yet.
    expect(
      manifestStatusFor({
        ...base,
        kind: 'psd',
        mimeType: 'image/vnd.adobe.photoshop',
        planned: false,
      }),
    ).toBe('unsupported');
    // Planned, not discovered yet; pending; ready; failed; unsupported.
    expect(manifestStatusFor({ ...base, kind: 'image', mimeType: 'image/png' })).toBe('pending');
    expect(
      manifestStatusFor({
        ...base,
        kind: 'image',
        mimeType: 'image/png',
        rows: [preview({ status: 'pending' })],
      }),
    ).toBe('pending');
    expect(
      manifestStatusFor({
        ...base,
        kind: 'image',
        mimeType: 'image/png',
        rows: [preview(), preview({ kind: 'thumb', status: 'pending' })],
      }),
    ).toBe('ready');
    expect(
      manifestStatusFor({
        ...base,
        kind: 'image',
        mimeType: 'image/png',
        rows: [preview({ status: 'failed' })],
      }),
    ).toBe('failed');
    expect(
      manifestStatusFor({
        ...base,
        kind: 'image',
        mimeType: 'image/png',
        rows: [preview({ status: 'unsupported' })],
      }),
    ).toBe('unsupported');
    // The scan decides first.
    expect(
      manifestStatusFor({
        ...base,
        access: 'pending_scan',
        kind: 'pdf',
        mimeType: 'application/pdf',
      }),
    ).toBe('pending');
    expect(
      manifestStatusFor({
        ...base,
        access: 'scan_required_by_policy',
        kind: 'pdf',
        mimeType: 'application/pdf',
      }),
    ).toBe('pending');
    expect(
      manifestStatusFor({ ...base, access: 'blocked', kind: 'pdf', mimeType: 'application/pdf' }),
    ).toBe('failed');
  });

  it('lists ready derivatives with their content path, and the media original inline', async () => {
    const t = build({
      previews: [
        preview(),
        preview({ id: 'p-thumb', kind: 'thumb', status: 'pending', objectKey: null }),
        preview({ id: 'p-meta', kind: 'media_meta', mimeType: 'application/json' }),
      ],
    });
    const manifest = await t.service.manifest(context, staff, 'internal', input);
    expect(manifest.kind).toBe('image');
    expect(manifest.status).toBe('ready');
    expect(manifest.derivatives).toEqual([
      {
        id: PREVIEW_ID,
        kind: 'preview',
        pageNo: 0,
        url: `/v1/organizations/atlas/files/${ASSET}/preview/${PREVIEW_ID}/content`,
        mimeType: 'image/webp',
        width: 2048,
        height: 1024,
      },
    ]);
    expect(manifest.originalUrl).toBe(`/v1/organizations/atlas/files/${ASSET}/content`);
    expect(JSON.stringify(manifest)).not.toContain('tenant/');

    const video = build({ version: version({ detectedMimeType: 'video/mp4' }) });
    const media = await video.service
      .manifest(context, client(), 'client', input)
      .catch(() => null);
    expect(media).toBeNull(); // unpublished deliverable: the client is refused
    const staffMedia = await video.service.manifest(context, staff, 'internal', input);
    expect(staffMedia.originalUrl).toBe(`/v1/organizations/atlas/files/${ASSET}/content?inline=1`);
  });

  it('carries the video facts and the codec notice from the media_meta row (R4 slice 9)', async () => {
    const meta = (values: Record<string, unknown>) =>
      preview({
        id: 'p-media',
        kind: 'media_meta',
        objectKey: null,
        mimeType: null,
        sizeBytes: 0,
        width: 1920,
        height: 1080,
        meta: values,
      });
    const hevc = build({
      version: version({ detectedMimeType: 'video/quicktime' }),
      previews: [
        meta({
          durationMs: 90_000,
          hasVideo: true,
          hasAudio: true,
          width: 1920,
          height: 1080,
          rotation: 90,
          frameRate: 25,
          videoCodec: 'HEVC',
          audioCodec: 'AAC',
          sampleRate: 48000,
          channels: 2,
          codecNotice: 'video_codec',
          container: 'MPEG-4',
        }),
      ],
    });
    const manifest = await hevc.service.manifest(context, staff, 'internal', input);
    expect(manifest.status).toBe('ready');
    expect(manifest.durationMs).toBe(90_000);
    expect(manifest.media).toEqual({
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      rotation: 90,
      frameRate: 25,
      videoCodec: 'HEVC',
      audioCodec: 'AAC',
      sampleRate: 48000,
      channels: 2,
      codecNotice: 'video_codec',
    });
    // A facts-only row is never a derivative a browser could fetch.
    expect(manifest.derivatives).toEqual([]);

    const odd = build({
      version: version({ detectedMimeType: 'audio/mpeg' }),
      previews: [meta({ hasAudio: true, rotation: 33, codecNotice: 'nope', audioCodec: 7 })],
    });
    expect((await odd.service.manifest(context, staff, 'internal', input)).media).toMatchObject({
      hasVideo: false,
      rotation: 0,
      audioCodec: null,
      codecNotice: null,
    });

    const waiting = build({ version: version({ detectedMimeType: 'video/mp4' }) });
    expect((await waiting.service.manifest(context, staff, 'internal', input)).media).toBeNull();
  });

  it('carries PSD layers, the ZIP list and Office facts from their rows (R4 slice 10)', async () => {
    const facts = (kind: FilePreview['kind'], meta: Record<string, unknown>, size?: number) =>
      preview({
        id: `p-${kind}`,
        kind,
        objectKey: null,
        mimeType: null,
        sizeBytes: 0,
        width: size ?? null,
        height: size ?? null,
        meta,
      });

    const photoshop = build({
      version: version({ detectedMimeType: 'image/vnd.adobe.photoshop' }),
      previews: [
        preview({ meta: { approximate: true } }),
        facts(
          'psd_layers',
          {
            layerCount: 2,
            groupCount: 1,
            approximate: true,
            layers: [
              {
                name: 'Headline',
                kind: 'group',
                visible: true,
                opacity: 100,
                blendMode: 'pass through',
                children: [
                  {
                    name: 'Logo',
                    kind: 'smart_object',
                    visible: true,
                    opacity: 100,
                    blendMode: 'normal',
                  },
                ],
              },
              {
                name: 'Grade',
                kind: 'adjustment',
                visible: false,
                opacity: 250,
                blendMode: 'normal',
              },
              { name: 'Odd', kind: 'script', visible: true },
            ],
          },
          4200,
        ),
      ],
    });
    const psd = await photoshop.service.manifest(context, staff, 'internal', input);
    expect(psd.kind).toBe('psd');
    expect(psd.status).toBe('ready');
    expect(psd.approximate).toBe(true);
    expect(psd.psd).toEqual({
      width: 4200,
      height: 4200,
      layerCount: 2,
      groupCount: 1,
      approximate: true,
      layers: [
        {
          name: 'Headline',
          kind: 'group',
          visible: true,
          opacity: 100,
          blendMode: 'pass through',
          children: [
            {
              name: 'Logo',
              kind: 'smart_object',
              visible: true,
              opacity: 100,
              blendMode: 'normal',
              children: [],
            },
          ],
        },
        {
          name: 'Grade',
          kind: 'adjustment',
          visible: false,
          opacity: 100,
          blendMode: 'normal',
          children: [],
        },
      ],
    });
    expect(psd.zip).toBeNull();
    expect(psd.office).toBeNull();

    const archive = build({
      version: version({ detectedMimeType: 'application/zip' }),
      previews: [
        facts('zip_manifest', {
          fileCount: 1,
          folderCount: 1,
          totalBytes: 84,
          compressedBytes: 60,
          encrypted: false,
          entries: [
            { path: 'Logos/', folder: true, sizeBytes: 0, modifiedAt: null },
            {
              path: 'Logos/a.svg',
              folder: false,
              sizeBytes: 84,
              modifiedAt: '2026-10-28T14:05:00',
            },
            { folder: false },
          ],
        }),
      ],
    });
    const zip = await archive.service.manifest(context, staff, 'internal', input);
    expect(zip.kind).toBe('zip');
    expect(zip.status).toBe('ready');
    expect(zip.derivatives).toEqual([]);
    expect(zip.zip?.entries).toEqual([
      { path: 'Logos/', folder: true, sizeBytes: 0, modifiedAt: null },
      { path: 'Logos/a.svg', folder: false, sizeBytes: 84, modifiedAt: '2026-10-28T14:05:00' },
    ]);
    expect(zip.zip).toMatchObject({ fileCount: 1, folderCount: 1, totalBytes: 84 });

    const bomb = build({
      version: version({ detectedMimeType: 'application/zip' }),
      previews: [facts('zip_manifest', {})].map((row) => ({
        ...row,
        status: 'unsupported' as const,
        meta: null,
      })),
    });
    const refused = await bomb.service.manifest(context, staff, 'internal', input);
    expect(refused.status).toBe('unsupported');
    expect(refused.zip).toBeNull();

    const deck = build({
      version: version({
        detectedMimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
      previews: [
        facts('office_meta', {
          format: 'pptx',
          pages: 12,
          pageWidth: 12_192_000,
          pageHeight: 6_858_000,
          sheets: [],
          approximate: true,
        }),
      ],
    });
    const pptx = await deck.service.manifest(context, staff, 'internal', input);
    expect(pptx.kind).toBe('office_pptx');
    expect(pptx.status).toBe('ready');
    expect(pptx.pages).toBe(12);
    expect(pptx.approximate).toBe(true);
    expect(pptx.originalUrl).toBe(`/v1/organizations/atlas/files/${ASSET}/content`);
    expect(pptx.office).toEqual({
      format: 'pptx',
      pages: 12,
      pageWidth: 12_192_000,
      pageHeight: 6_858_000,
      sheets: [],
    });

    // Office files render from the original even before the facts row is read.
    const early = build({
      version: version({
        detectedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    });
    const xlsx = await early.service.manifest(context, staff, 'internal', input);
    expect(xlsx.status).toBe('ready');
    expect(xlsx.office).toBeNull();
  });

  it('marks an EPS preview as the one embedded in the file (R4 slice 10)', async () => {
    const t = build({
      version: version({ detectedMimeType: 'application/postscript' }),
      previews: [preview({ meta: { embeddedPreview: true } })],
    });
    const manifest = await t.service.manifest(context, staff, 'internal', input);
    expect(manifest.kind).toBe('unsupported');
    expect(manifest.status).toBe('ready');
    expect(manifest.embeddedPreview).toBe(true);
    expect(manifest.derivatives).toHaveLength(1);

    const none = build({
      version: version({ detectedMimeType: 'application/postscript' }),
      previews: [preview({ status: 'unsupported', objectKey: null, mimeType: null })],
    });
    const bare = await none.service.manifest(context, staff, 'internal', input);
    expect(bare.status).toBe('unsupported');
    expect(bare.embeddedPreview).toBe(false);
  });

  it('builds portal paths for the client door', async () => {
    const t = build({ previews: [preview()], published: { projectId: PROJECT } });
    const manifest = await t.service.manifest(context, client(), 'client', input);
    expect(manifest.derivatives[0]?.url).toBe(
      `/v1/organizations/atlas/portal/files/${ASSET}/preview/${PREVIEW_ID}/content`,
    );
  });

  it('shows no bytes while the file waits for its scan, and says so', async () => {
    const t = build({
      asset: asset({ status: 'scanning' }),
      version: version({ scanVerdict: null, trustZone: 'quarantine' }),
      previews: [preview()],
    });
    // No scanner configured → allow_labeled: servable, labelled not_scanned.
    const labelled = await t.service.manifest(context, staff, 'internal', input);
    expect(labelled.version?.scanStatus).toBe('not_scanned');

    const blocked = build({
      asset: asset({ status: 'rejected' }),
      version: version({ scanVerdict: 'infected' }),
      previews: [preview()],
    });
    const manifest = await blocked.service.manifest(context, staff, 'internal', input);
    expect(manifest.status).toBe('failed');
    expect(manifest.version?.scanStatus).toBe('blocked');
    expect(manifest.derivatives).toEqual([]);
    expect(manifest.originalUrl).toBeNull();
    expect(manifest.capabilities.canDownload).toBe(false);
  });

  it('gives a client viewer no comment or decision buttons, and staff the upload button', async () => {
    const t = build({ published: { projectId: PROJECT } });
    const viewer = await t.service.manifest(context, client('client_viewer'), 'client', input);
    expect(viewer.capabilities).toMatchObject({
      canComment: false,
      canDecide: false,
      canUploadVersion: false,
      canDownload: true,
    });
    const reviewer = await t.service.manifest(context, client('client_reviewer'), 'client', input);
    expect(reviewer.capabilities).toMatchObject({
      canComment: true,
      canDecide: true,
      canUploadVersion: false,
    });
    const studio = await t.service.manifest(context, staff, 'internal', input);
    expect(studio.capabilities).toMatchObject({ canComment: true, canUploadVersion: true });

    const archived = build({ archived: true });
    const readOnly = await archived.service.manifest(context, staff, 'internal', input);
    expect(readOnly.capabilities).toMatchObject({ canComment: false, canUploadVersion: false });
  });

  it('names the deliverable version only when it really names this file', async () => {
    const t = build();
    const plain = await t.service.manifest(context, staff, 'internal', input);
    expect(plain.decisionContext).toEqual({
      kind: 'file',
      deliverableId: null,
      deliverableVersionId: null,
    });
    const deliverable = await t.service.manifest(context, staff, 'internal', {
      ...input,
      deliverableVersionId: DELIVERABLE_VERSION,
    });
    expect(deliverable.decisionContext).toEqual({
      kind: 'deliverable',
      deliverableId: DELIVERABLE,
      deliverableVersionId: DELIVERABLE_VERSION,
    });
    const wrong = await t.service.manifest(context, staff, 'internal', {
      ...input,
      deliverableVersionId: '00000000-0000-4000-8000-000000000999',
    });
    expect(wrong.decisionContext.kind).toBe('file');
  });

  it('lists the chain newest first, the client seeing only the versions it may open', async () => {
    const internalV2 = asset({ id: V2_ASSET, audience: 'internal', name: 'v2.png' });
    const t = build({ chain: [internalV2], published: { projectId: PROJECT } });
    const studio = await t.service.manifest(context, staff, 'internal', input);
    expect(studio.versions.versions.map((v) => [v.versionNo, v.fileAssetId, v.current])).toEqual([
      [2, V2_ASSET, true],
      [1, ASSET, false],
    ]);
    const portal = await t.service.manifest(context, client(), 'client', input);
    expect(portal.versions.versions.map((v) => v.fileAssetId)).toEqual([ASSET]);
  });

  it('audits one view per principal and file per window, not one per tile', async () => {
    const t = build({ previews: [preview()] });
    await t.service.manifest(context, staff, 'internal', input);
    await t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID);
    await t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID);
    expect(t.allowed.filter((row) => row.action === 'file_preview.viewed')).toHaveLength(1);
  });
});

describe('derivative content', () => {
  it('serves a ready derivative of the served version', async () => {
    const t = build({ previews: [preview()] });
    const content = await t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID);
    expect(content.mimeType).toBe('image/webp');
    expect(await drain(content.stream)).toBe('webp');
  });

  it('refuses another version, another file, a pending row and a non-inline type with the one 404', async () => {
    for (const row of [
      preview({ fileVersionId: '00000000-0000-4000-8000-0000000000f9' }),
      preview({ fileAssetId: V2_ASSET }),
      preview({ status: 'pending' }),
      preview({ mimeType: 'text/html' }),
      preview({ kind: 'media_meta', mimeType: 'image/png' }),
    ]) {
      const t = build({ previews: [row] });
      const error = await refusal(t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID));
      expect(error.status).toBe(404);
      expect(t.denials).toEqual(['preview_not_found']);
    }
  });

  it('serves an SVG only as the sanitised copy', () => {
    expect(isInlineDerivative(preview({ kind: 'svg_safe', mimeType: 'image/svg+xml' }))).toBe(true);
    expect(isInlineDerivative(preview({ kind: 'preview', mimeType: 'image/svg+xml' }))).toBe(false);
    expect(isInlineDerivative(preview({ kind: 'thumb', mimeType: 'image/jpeg' }))).toBe(true);
  });

  it('answers the scan 409 while the file may not be served', async () => {
    const t = build({
      asset: asset({ status: 'rejected' }),
      version: version({ scanVerdict: 'infected' }),
      previews: [preview()],
    });
    expect(
      (await refusal(t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID))).status,
    ).toBe(409);
  });

  it('answers 404 when the derivative bytes are gone', async () => {
    const t = build({ previews: [preview({ objectKey: 'tenant/org/derivative/v/missing' })] });
    expect(
      (await refusal(t.service.content(context, staff, 'internal', ASSET, PREVIEW_ID))).status,
    ).toBe(404);
    expect(t.denials).toEqual(['derivative_missing']);
  });
});

describe('retry', () => {
  it('puts failed rows back and asks the job for a pass; clients have no retry door', async () => {
    const t = build({
      previews: [preview({ status: 'failed' }), preview({ id: 'p2', kind: 'thumb' })],
    });
    expect(await t.service.retry(context, staff, ASSET)).toEqual({ reset: 1 });
    expect(t.requested()).toBe(1);
    expect(await t.service.retry(context, staff, ASSET)).toEqual({ reset: 0 });
    expect(t.requested()).toBe(1);
    expect((await refusal(t.service.retry(context, client(), ASSET))).status).toBe(403);
  });
});

describe('ViewAuditDebounce', () => {
  it('takes a key once per window', () => {
    const debounce = new ViewAuditDebounce(1000, 2);
    expect(debounce.take('a', 0)).toBe(true);
    expect(debounce.take('a', 500)).toBe(false);
    expect(debounce.take('a', 1500)).toBe(true);
    expect(debounce.take('b', 1500)).toBe(true);
    // Full: cleared rather than grown.
    expect(debounce.take('c', 1600)).toBe(true);
    expect(debounce.take('a', 1600)).toBe(true);
  });
});
