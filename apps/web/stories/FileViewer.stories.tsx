import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';
import { withStubbedNetwork } from './support/vr-fixtures';

/**
 * **R4 proofing viewer — image with pins (Figma V-03 `463:23226`).** The Atlas homepage hero sample
 * from batch A as an inline SVG (no network), four open threads and one resolved: pins 1–3, the
 * dashed box of thread 4 with its pin on the corner, the resolved pin 5 muted, and the comments rail
 * with All / Open / Resolved / Mine. The same fixtures as `tests/r4-file-viewer.test.tsx`.
 */

const HERO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
  <rect width="1440" height="900" fill="#ffffff"/>
  <rect width="1440" height="88" fill="#090a09"/>
  <text x="48" y="54" font-family="Manrope, sans-serif" font-size="22" fill="#ffffff" letter-spacing="2">ATLAS HOSPITALITY</text>
  <text x="900" y="54" font-family="Manrope, sans-serif" font-size="22" fill="#ffffff">Rooms   Offers   Dining   Contact</text>
  <text x="48" y="220" font-family="Manrope, sans-serif" font-size="52" fill="#090a09">Wake up to the</text>
  <text x="48" y="282" font-family="Manrope, sans-serif" font-size="52" fill="#090a09">Mediterranean</text>
  <text x="48" y="360" font-family="Manrope, sans-serif" font-size="28" fill="#4d5049">Sea-view rooms in Alexandria from EGP 3,400</text>
  <rect x="48" y="440" width="280" height="76" rx="38" fill="#090a09"/>
  <text x="104" y="488" font-family="Manrope, sans-serif" font-size="26" fill="#ffffff">Book a room</text>
  <rect x="780" y="128" width="620" height="490" rx="28" fill="#e9ffd0"/>
  <rect x="780" y="400" width="620" height="218" fill="#7755c7"/>
  <circle cx="1180" cy="240" r="70" fill="#b7ff57"/>
  <rect x="48" y="680" width="420" height="170" rx="16" fill="#ffffff" stroke="#c5c7c0" stroke-width="2"/>
  <rect x="510" y="680" width="420" height="170" rx="16" fill="#ffffff" stroke="#c5c7c0" stroke-width="2"/>
  <rect x="972" y="680" width="420" height="170" rx="16" fill="#ffffff" stroke="#c5c7c0" stroke-width="2"/>
  <text x="80" y="740" font-family="Manrope, sans-serif" font-size="28" fill="#090a09">Summer weekend</text>
  <text x="542" y="740" font-family="Manrope, sans-serif" font-size="28" fill="#090a09">Family suite</text>
  <text x="1004" y="740" font-family="Manrope, sans-serif" font-size="28" fill="#090a09">Dinner by the sea</text>
</svg>`,
)}`;

const MANIFEST = {
  media: null,
  file: { id: 'f1', name: 'homepage-hero-v2.png', projectId: 'p1' },
  version: { fileVersionId: 'fv2', mimeType: 'image/png', sizeBytes: 482_113, scanStatus: 'clean' },
  kind: 'image',
  status: 'ready',
  derivatives: [
    {
      id: 'd1',
      kind: 'preview',
      pageNo: 0,
      url: HERO,
      mimeType: 'image/svg+xml',
      width: 1440,
      height: 900,
    },
  ],
  originalUrl: '/v1/organizations/northstar/files/f1/content',
  pages: null,
  durationMs: null,
  approximate: false,
  linkedImagesRemoved: false,
  embeddedPreview: false,
  psd: null,
  zip: null,
  fig: null,
  office: null,
  versions: {
    rootFileAssetId: 'f0',
    versions: [
      {
        versionNo: 2,
        fileAssetId: 'f1',
        fileName: 'homepage-hero-v2.png',
        createdAt: '2026-10-30T10:00:00.000Z',
        current: true,
      },
      {
        versionNo: 1,
        fileAssetId: 'f0',
        fileName: 'homepage-hero.png',
        createdAt: '2026-10-20T10:00:00.000Z',
        current: false,
      },
    ],
  },
  decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
  capabilities: {
    canReview: true,
    canComment: true,
    canDraw: true,
    canResolve: true,
    canDecide: true,
    canUploadVersion: true,
    canDownload: true,
    canRetry: true,
    canDelete: false,
  },
} as FilePreviewManifest;

const AT = '2026-08-09T11:40:00.000Z';

function person(name: string, kind: 'internal' | 'client' = 'internal') {
  return { membershipId: `m-${name}`, displayName: name, kind };
}

function thread(
  number: number,
  name: string,
  body: string,
  anchor: Record<string, number>,
  extra: Partial<ReviewThread> = {},
): ReviewThread {
  const author = person(
    name,
    name === 'Youssef Kamal' || name === 'Salma Riad' ? 'client' : 'internal',
  );
  return {
    id: `t${number}`,
    number,
    subjectType: 'file_asset',
    subjectId: 'f0',
    fileVersionId: 'fv2',
    anchorKind: 'w' in anchor ? 'box' : 'pin',
    anchor,
    pageNo: null,
    timeMs: null,
    audience: author.kind === 'client' ? 'client_visible' : 'internal',
    status: 'open',
    createdBy: author,
    createdAt: AT,
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [
      {
        id: `c${number}`,
        threadId: `t${number}`,
        body,
        mentions: [],
        author,
        createdAt: AT,
        editedAt: null,
        canEdit: false,
        canDelete: false,
      },
    ],
    canResolve: true,
    canMove: false,
    ...extra,
  };
}

const THREADS: readonly ReviewThread[] = [
  thread(1, 'Maya Hassan', 'Keep the headline on one line on desktop.', { x: 0.42, y: 0.12 }),
  thread(2, 'Youssef Kamal', 'Can the button say “Book your stay”?', { x: 0.21, y: 0.47 }),
  thread(3, 'Lina Samir', 'Swap in the real terrace photo before we publish.', {
    x: 0.88,
    y: 0.13,
  }),
  thread(4, 'Salma Riad', 'Prices need “per night” after them.', {
    x: 0.03,
    y: 0.74,
    w: 0.94,
    h: 0.22,
  }),
  thread(
    5,
    'Maya Hassan',
    'Logo is too close to the menu.',
    { x: 0.06, y: 0.03 },
    {
      status: 'resolved',
      resolvedBy: person('Lina Samir'),
      resolvedAt: AT,
    },
  ),
];

function viewerClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/review/threads')
        ? { threads: THREADS }
        : url.includes('/preview')
          ? MANIFEST
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-story',
    newCorrelationId: () => 'correlation-story',
  });
}

const meta = {
  title: 'VR/File viewer',
  component: FileViewer,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  parameters: { layout: 'fullscreen' },
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    fileId: 'f1',
    client: viewerClient(),
    apiBase: '',
  },
} satisfies Meta<typeof FileViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ImageWithPins: Story = {};
