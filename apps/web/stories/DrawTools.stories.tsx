import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileViewer } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';
import { markVrReady, waitForElement, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **R4 proofing viewer — Draw tool (Figma V-12 `463:27125`).** The Atlas homepage sample with the
 * three kinds of saved drawing from the design — a red pen loop round the headline, a red arrow at
 * the booking button and a red rectangle round the third offer card — each with its numbered pin
 * at the drawing's top-left, and the draw toolbar open (Pen · Arrow · Rectangle, seven colours,
 * three widths, Undo, Done). The play function picks the Draw tool, then marks the shot ready.
 */

const PAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="780" viewBox="0 0 1200 780">
  <rect width="1200" height="780" fill="#ffffff"/>
  <text x="48" y="62" font-family="Manrope, sans-serif" font-size="22" fill="#090a09">ATLAS HOSPITALITY</text>
  <text x="760" y="62" font-family="Manrope, sans-serif" font-size="18" fill="#090a09">Rooms   Dining   Offers   Contact</text>
  <rect x="48" y="96" width="1104" height="390" rx="16" fill="#090a09"/>
  <text x="96" y="220" font-family="Manrope, sans-serif" font-size="56" fill="#ffffff">Stay by the sea</text>
  <text x="96" y="290" font-family="Manrope, sans-serif" font-size="56" fill="#ffffff">in Alexandria</text>
  <text x="96" y="350" font-family="Manrope, sans-serif" font-size="24" fill="#ffffff">Sea-view rooms from 2,400 EGP a night</text>
  <rect x="96" y="390" width="230" height="60" rx="30" fill="#b7ff57"/>
  <text x="146" y="428" font-family="Manrope, sans-serif" font-size="22" fill="#090a09">Book a room</text>
  <rect x="48" y="520" width="344" height="210" rx="10" fill="#e9e9e5"/>
  <rect x="428" y="520" width="344" height="210" rx="10" fill="#e9e9e5"/>
  <rect x="808" y="520" width="344" height="210" rx="10" fill="#e9e9e5"/>
  <text x="72" y="680" font-family="Manrope, sans-serif" font-size="22" fill="#090a09">Sea-view suite</text>
  <text x="452" y="680" font-family="Manrope, sans-serif" font-size="22" fill="#090a09">Family room</text>
  <text x="832" y="680" font-family="Manrope, sans-serif" font-size="22" fill="#090a09">Spa weekend</text>
</svg>`,
)}`;

const MANIFEST = {
  media: null,
  file: { id: 'f1', name: 'homepage-concept-v2.png', projectId: 'p1' },
  version: { fileVersionId: 'fv2', mimeType: 'image/png', sizeBytes: 412_008, scanStatus: 'clean' },
  kind: 'image',
  status: 'ready',
  derivatives: [
    {
      id: 'd1',
      kind: 'preview',
      pageNo: 0,
      url: PAGE,
      mimeType: 'image/svg+xml',
      width: 1200,
      height: 780,
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
    rootFileAssetId: 'f1',
    versions: [
      {
        versionNo: 2,
        fileAssetId: 'f1',
        fileName: 'homepage-concept-v2.png',
        createdAt: '2026-10-30T10:00:00.000Z',
        current: true,
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
const RED = '#d9474f';

function drawing(
  number: number,
  name: string,
  body: string,
  strokes: readonly Record<string, unknown>[],
): ReviewThread {
  const author = { membershipId: `m-${name}`, displayName: name, kind: 'internal' as const };
  return {
    id: `t${number}`,
    number,
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: 'fv2',
    anchorKind: 'draw',
    anchor: { strokes },
    pageNo: null,
    timeMs: null,
    audience: 'internal',
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
  } as ReviewThread;
}

/** A loose hand-drawn loop round the headline, as relative points. */
const LOOP = [
  [0.07, 0.31],
  [0.12, 0.23],
  [0.25, 0.22],
  [0.38, 0.23],
  [0.45, 0.27],
  [0.44, 0.33],
  [0.36, 0.38],
  [0.22, 0.39],
  [0.1, 0.37],
  [0.07, 0.33],
];

const THREADS: readonly ReviewThread[] = [
  drawing(1, 'Maya Hassan', 'Headline should sit on one line on desktop.', [
    { tool: 'pen', color: RED, width: 4, points: LOOP },
  ]),
  drawing(2, 'Omar Adel', 'Make the booking button the first thing you see.', [
    {
      tool: 'arrow',
      color: RED,
      width: 4,
      points: [
        [0.46, 0.42],
        [0.29, 0.54],
      ],
    },
  ]),
  drawing(3, 'Lina Samir', 'Spa weekend needs the new photo.', [
    {
      tool: 'rect',
      color: RED,
      width: 4,
      points: [
        [0.665, 0.655],
        [0.97, 0.945],
      ],
    },
  ]),
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
  title: 'VR/File viewer drawing',
  component: FileViewer,
  tags: ['vr', 'vr-play'],
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

export const DrawingsAndToolbar: Story = {
  play: async ({ canvasElement }) => {
    try {
      await waitForElement(canvasElement, '.tm-viewer-draw__thread', 5_000);
      const tools = canvasElement.querySelectorAll<HTMLButtonElement>('.tm-viewer-tools__tool');
      tools[tools.length - 1]?.click();
      await waitForElement(canvasElement, '.tm-viewer-draw-bar', 3_000);
    } catch {
      // The viewer did not reach its stage; the shot shows what did render.
    }
    markVrReady();
  },
};
