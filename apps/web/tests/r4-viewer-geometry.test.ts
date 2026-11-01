import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  boxBetween,
  fitZoom,
  popoverPlacement,
  readBox,
  readPoint,
  stepZoom,
  toNormalizedPoint,
} from '../src/components/viewer/viewer-geometry';
import { stripWindow } from '../src/components/viewer/PageStrip';
import { mentionQueryAt, mentionsStillIn } from '../src/components/viewer/ThreadComposer';
import { readableBody } from '../src/components/viewer/ThreadCard';
import { filterThreads, formatBytes } from '../src/components/viewer/ThreadPanel';
import { stageFor, threadsOnStage } from '../src/components/viewer/FileViewer';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';

/**
 * R4 slice 6 — the viewer's arithmetic and decisions, without a DOM: anchors relative to the
 * artwork (never mirrored), boxes, zoom steps and fit, the page strip window, @mention parsing,
 * the panel filters and what the stage shows for each manifest.
 */

const rect = { left: 100, top: 50, width: 400, height: 200 };

describe('anchors', () => {
  it('turns a pointer into a point on the artwork, clamped and rounded', () => {
    expect(toNormalizedPoint(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalizedPoint(50, 400, rect)).toEqual({ x: 0, y: 1 });
    expect(toNormalizedPoint(100 + 400 / 3, 50, rect)).toEqual({ x: 0.3333, y: 0 });
    expect(toNormalizedPoint(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });

  it('is the same point whatever the zoom: the anchor is relative, not pixels', () => {
    const at100 = toNormalizedPoint(100 + 120, 50 + 40, rect);
    const at200 = toNormalizedPoint(100 + 240, 50 + 80, { ...rect, width: 800, height: 400 });
    expect(at100).toEqual(at200);
  });

  it('makes a box from two corners in any drag direction; a tiny drag is no box', () => {
    expect(boxBetween({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 })).toEqual({
      x: 0.2,
      y: 0.3,
      w: 0.4,
      h: 0.4,
    });
    expect(boxBetween({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.9 })).toBeNull();
  });

  it('reads stored anchors defensively', () => {
    expect(readPoint({ x: 0.2, y: 1.4 })).toEqual({ x: 0.2, y: 1 });
    expect(readPoint({ x: '1', y: 0 })).toBeNull();
    expect(readPoint(null)).toBeNull();
    expect(readBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 })).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
    expect(readBox({ x: 0.1, y: 0.1 })).toBeNull();
  });

  it('opens the popover on the free side of the anchor (physical, never mirrored)', () => {
    expect(popoverPlacement({ x: 0.2, y: 0.2 })).toEqual({ side: 'right', vertical: 'below' });
    expect(popoverPlacement({ x: 0.9, y: 0.8 })).toEqual({ side: 'left', vertical: 'above' });
  });
});

describe('zoom', () => {
  it('steps through the zoom ladder from anywhere, including after Fit', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.83, 1)).toBe(1);
    expect(stepZoom(0.83, -1)).toBe(0.75);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });

  it('fits the artwork into the stage (contain) or by width (PDF)', () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 1000 }, 'contain')).toBe(
      0.5,
    );
    expect(fitZoom({ width: 800, height: 1100 }, { width: 800, height: 500 }, 'width')).toBe(1);
    expect(
      fitZoom({ width: 800, height: 1100 }, { width: 800, height: 500 }, 'contain'),
    ).toBeCloseTo(0.4545, 3);
    expect(fitZoom({ width: 0, height: 0 }, { width: 10, height: 10 }, 'contain')).toBe(1);
  });
});

describe('page strip', () => {
  it('shows six pages around the current one', () => {
    expect(stripWindow(12, 3)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stripWindow(12, 8)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(stripWindow(12, 12)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(stripWindow(3, 2)).toEqual([1, 2, 3]);
    expect(stripWindow(0, 1)).toEqual([]);
  });
});

describe('mentions in the composer', () => {
  it('finds the @query being typed before the caret', () => {
    expect(mentionQueryAt('Hi @ma', 6)).toEqual({ start: 3, query: 'ma' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail me@home', 12)).toBeNull();
    expect(mentionQueryAt('Hi @maya done', 13)).toBeNull();
  });

  it('sends only the people still named in the text', () => {
    const picked = new Map([
      ['Maya Hassan', 'u-maya'],
      ['Omar Adel', 'u-omar'],
    ]);
    expect(mentionsStillIn('Thanks @Maya Hassan', picked)).toEqual(['u-maya']);
    expect(mentionsStillIn('nobody', picked)).toEqual([]);
  });

  it('never shows a raw user id', () => {
    expect(readableBody('ask @0f8c1e8a-1b2c-4d5e-8f90-123456789abc please', 'someone')).toBe(
      'ask @someone please',
    );
  });
});

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: 't',
    number: 1,
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: 'fv2',
    anchorKind: 'pin',
    anchor: { x: 0.5, y: 0.5 },
    pageNo: null,
    timeMs: null,
    audience: 'internal',
    status: 'open',
    createdBy: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
    createdAt: '2026-11-01T09:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [],
    canResolve: true,
    canMove: false,
    ...overrides,
  };
}

const mineComment = {
  id: 'c',
  threadId: 't',
  body: 'x',
  mentions: [],
  author: { membershipId: 'me', displayName: 'Omar Adel', kind: 'internal' as const },
  createdAt: '2026-11-01T09:00:00.000Z',
  editedAt: null,
  canEdit: true,
  canDelete: true,
};

describe('panel filters', () => {
  const threads = [
    thread({ id: 'a', number: 3, status: 'resolved', pageNo: 1 }),
    thread({ id: 'b', number: 2, pageNo: 2, comments: [mineComment] }),
    thread({ id: 'c', number: 1, pageNo: 1 }),
  ];

  it('lists open threads first, then by number', () => {
    expect(filterThreads(threads, 'all', null).map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect(filterThreads(threads, 'open', null).map((t) => t.id)).toEqual(['c', 'b']);
    expect(filterThreads(threads, 'resolved', null).map((t) => t.id)).toEqual(['a']);
    expect(filterThreads(threads, 'mine', null).map((t) => t.id)).toEqual(['b']);
    expect(filterThreads(threads, 'page', 1).map((t) => t.id)).toEqual(['c']);
  });

  it('puts on the stage only pins and boxes of this version and page', () => {
    const list = [
      thread({ id: 'p', pageNo: 2 }),
      thread({ id: 'q', pageNo: 3 }),
      thread({ id: 'old', pageNo: 2, fileVersionId: 'fv1' }),
      thread({ id: 'g', anchorKind: 'none', anchor: null, pageNo: 2 }),
    ];
    expect(threadsOnStage(list, 'fv2', 2).map((t) => t.id)).toEqual(['p']);
    expect(threadsOnStage(list, null, null).map((t) => t.id)).toEqual(['p', 'q', 'old']);
  });

  it('formats sizes', () => {
    expect(formatBytes(512, String)).toBe('512 B');
    expect(formatBytes(1536, String)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024, String)).toBe('5 MB');
  });
});

function manifest(overrides: Partial<FilePreviewManifest>): FilePreviewManifest {
  // Asserted rather than annotated so the fixture also fits while later slices add fields.
  return {
    media: null,
    file: { id: 'f1', name: 'hero.png', projectId: 'p1' },
    version: { fileVersionId: 'fv2', mimeType: 'image/png', sizeBytes: 10, scanStatus: 'clean' },
    kind: 'image',
    status: 'ready',
    derivatives: [],
    originalUrl: '/v1/organizations/o/files/f1/content',
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
    versions: { rootFileAssetId: 'f1', versions: [] },
    decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
    capabilities: {
      canComment: true,
      canDraw: true,
      canResolve: true,
      canDecide: true,
      canUploadVersion: true,
      canDownload: true,
      canRetry: true,
    },
    ...overrides,
  } as FilePreviewManifest;
}

describe('what the stage shows', () => {
  it('shows the preview image, else the original image', () => {
    const preview = {
      id: 'd1',
      kind: 'preview',
      pageNo: 0,
      url: '/v1/organizations/o/files/f1/preview/d1/content',
      mimeType: 'image/webp',
      width: 10,
      height: 10,
    };
    expect(stageFor(manifest({ derivatives: [preview] }))).toEqual({
      stage: 'image',
      state: null,
      src: preview.url,
    });
    expect(stageFor(manifest({})).src).toBe('/v1/organizations/o/files/f1/content');
  });

  it('never shows an SVG original, only its safe copy', () => {
    expect(stageFor(manifest({ kind: 'svg' })).state).toBe('unsupported');
  });

  it('opens a PDF from the original', () => {
    expect(stageFor(manifest({ kind: 'pdf' })).stage).toBe('pdf');
  });

  it('says checking, preparing, failed, blocked or unsupported', () => {
    const scan = (scanStatus: 'pending_scan' | 'blocked') => ({
      fileVersionId: 'fv2',
      mimeType: 'image/png',
      sizeBytes: 10,
      scanStatus,
    });
    expect(
      stageFor(manifest({ status: 'pending', originalUrl: null, version: scan('pending_scan') }))
        .state,
    ).toBe('checking');
    expect(stageFor(manifest({ status: 'pending' })).state).toBe('preparing');
    expect(stageFor(manifest({ status: 'failed' })).state).toBe('failed');
    expect(stageFor(manifest({ status: 'failed', version: scan('blocked') })).state).toBe(
      'blocked',
    );
    expect(stageFor(manifest({ kind: 'zip', status: 'unsupported' })).state).toBe('unsupported');
  });
});

describe('pdf.js worker copy', () => {
  it('is the same pdf.js version as the installed pdfjs-dist', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(require.resolve('pdfjs-dist/package.json'), 'utf8')) as {
      version: string;
    };
    const worker = readFileSync(join(here, '..', 'public', 'pdf.worker.min.mjs'), 'utf8');
    expect(worker).toContain(`"${pkg.version}"`);
  });
});
