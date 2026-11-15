import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decisionShown,
  PortalFileViewerScreen,
} from '../src/components/screens/PortalFileViewerScreen';
import { portalFileViewerHref } from '../src/components/screens/PortalReviewLink';
import { threadsAsClientSees } from '../src/components/viewer/FileViewer';
import { ApiClient } from '../src/lib/api/client';
import type { ReviewThread } from '../src/lib/api/review';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 8 — the portal viewer (Figma batch E, V-40 – V-45) over a fake API.
 *
 * The rules (a client reads only client-visible threads, writes only client-visible ones, resolves
 * only its own) are the API's and proved in `review.service.test.ts`; this file proves the screen
 * talks through the client's routes under `/portal`, has no audience switch, carries the decision
 * card for a deliverable version, and that a team member's preview reads as the client: team-only
 * threads hidden and counted, nothing writable, nothing decidable.
 */

vi.mock('../src/components/viewer/pdf-document', () => ({
  PDF_WORKER_PATH: '/pdf.worker.min.mjs',
  PDF_POINTS_TO_CSS: 96 / 72,
  loadPdfDocument: () => ({ promise: new Promise(() => undefined), cancel: () => undefined }),
}));

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const BASE = 'https://api.example.test';

function manifest(door: 'portal' | 'studio') {
  const prefix = `/v1/organizations/northstar${door === 'portal' ? '/portal' : ''}/files/f1`;
  return {
    file: { id: 'f1', name: 'homepage-concept-v2.png', projectId: 'p1' },
    version: { fileVersionId: 'fv2', mimeType: 'image/png', sizeBytes: 2048, scanStatus: 'clean' },
    kind: 'image',
    status: 'ready',
    derivatives: [
      {
        id: 'd1',
        kind: 'preview',
        pageNo: 0,
        url: `${prefix}/preview/d1/content`,
        mimeType: 'image/webp',
        width: 1440,
        height: 900,
      },
    ],
    originalUrl: `${prefix}/content`,
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
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
    decisionContext: { kind: 'deliverable', deliverableId: 'del1', deliverableVersionId: 'dv1' },
    capabilities: {
      canComment: true,
      canDraw: true,
      canResolve: true,
      canDecide: door === 'portal',
      canUploadVersion: door === 'studio',
      canDownload: true,
      canRetry: door === 'studio',
      canDelete: false,
    },
  };
}

function person(name: string, kind: 'internal' | 'client' = 'internal') {
  return { membershipId: `m-${name}`, displayName: name, kind };
}

function thread(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    number: 1,
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: 'fv2',
    anchorKind: 'pin',
    anchor: { x: 0.25, y: 0.4 },
    pageNo: null,
    timeMs: null,
    audience: 'client_visible',
    status: 'open',
    createdBy: person('Youssef Kamal', 'client'),
    createdAt: '2026-10-31T10:12:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [
      {
        id: 'c1',
        threadId: 't1',
        body: 'Can “Book your stay” sit above the fold on phones too?',
        mentions: [],
        author: person('Youssef Kamal', 'client'),
        createdAt: '2026-10-31T10:12:00.000Z',
        editedAt: null,
        canEdit: true,
        canDelete: true,
      },
    ],
    canResolve: true,
    canMove: true,
    ...overrides,
  };
}

/** What the client door answers: client-visible threads only (the API filters). */
const CLIENT_THREADS = [thread({}), thread({ id: 't3', number: 3, anchor: { x: 0.6, y: 0.7 } })];
/** What the team's door answers: everything, team-only threads included. */
const TEAM_THREADS = [
  ...CLIENT_THREADS,
  thread({ id: 't2', number: 2, audience: 'internal', createdBy: person('Lina Samir') }),
  thread({ id: 't4', number: 4, audience: 'internal', createdBy: person('Omar Adel') }),
];

const APPROVAL = {
  id: 'ap1',
  deliverableId: 'del1',
  deliverableVersionId: 'dv1',
  contentHash: 'sha256:8f2cd41a99',
  projection: {
    title: 'Homepage concept',
    summary: null,
    milestoneState: null,
    forecastDate: null,
    publishedRisk: null,
    decision: null,
    approvedContacts: [],
  },
  publishedByUserId: 'u1',
  publishedAt: '2026-08-13T09:12:00.000Z',
  awaitingDecision: true,
};

function fakeApi(approval: typeof APPROVAL = APPROVAL) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: BASE,
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const portal = call.url.includes('/portal/');
      let body: unknown = {};
      if (call.url.includes('/preview')) body = manifest(portal ? 'portal' : 'studio');
      else if (call.url.includes('/review/threads') && call.method === 'GET') {
        body = { threads: portal ? CLIENT_THREADS : TEAM_THREADS };
      } else if (call.url.includes('/review/threads') && call.method === 'POST') {
        body = call.url.endsWith('/comments')
          ? thread({}).comments[0]
          : thread({ id: 't5', number: 5, comments: [] });
      } else if (call.url.includes('mention-candidates')) {
        body = {
          candidates: [
            { userId: 'u-omar', displayName: 'Omar Adel', kind: 'internal', mention: '@u-omar' },
            { userId: 'u-sara', displayName: 'Sara Nabil', kind: 'client', mention: '@u-sara' },
          ],
        };
      } else if (call.url.includes('/approvals/projections/dv1/decision')) {
        body = {
          deliverableVersionId: 'dv1',
          state: 'approved',
          decidedAt: '2026-11-01T09:00:00.000Z',
          feedback: null,
        };
      } else if (call.url.includes('/approvals/projections/dv1')) body = approval;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: call.method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPortal(
  api: ApiClient,
  options: { preview?: boolean; deliverableVersionId?: string } = {},
) {
  return render(
    withQuery(
      <PortalFileViewerScreen
        organizationSlug="northstar"
        fileId="f1"
        clientName="Seaside Hotels"
        providerName="Lumen Studio"
        client={api}
        apiBase={BASE}
        preview={options.preview ?? false}
        {...(options.deliverableVersionId
          ? { deliverableVersionId: options.deliverableVersionId }
          : {})}
      />,
    ),
  );
}

/** jsdom lays nothing out: give the artwork a 1000 × 500 box on screen. */
function sizeTheArtwork() {
  const image = document.querySelector('img.tm-viewer-art__media') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { value: 1440, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 900, configurable: true });
  fireEvent.load(image);
  const art = document.querySelector('.tm-viewer-art') as HTMLElement;
  art.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
      right: 1000,
      bottom: 500,
      x: 0,
      y: 0,
    }) as DOMRect;
  return art;
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('Portal viewer (R4 slice 8)', () => {
  it('a client reads through the portal routes, with a comments-only rail and no audience tags', async () => {
    const { client, calls } = fakeApi();
    const { container } = renderPortal(client);

    const image = await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    expect(image).toHaveAttribute(
      'src',
      `${BASE}/v1/organizations/northstar/portal/files/f1/preview/d1/content`,
    );
    sizeTheArtwork();
    await screen.findByRole('button', { name: 'Comment 1, open' });

    expect(calls.some((c) => c.url.endsWith('/portal/files/f1/preview'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/portal/files/f1/review/threads'))).toBe(true);
    // Never the team's routes.
    expect(calls.some((c) => /\/organizations\/northstar\/files\//u.test(c.url))).toBe(false);

    expect(screen.getByRole('heading', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const list = screen.getByRole('listbox', { name: 'Comments on this file' });
    expect(within(list).queryByText('Visible to client')).not.toBeInTheDocument();
    expect(
      screen.getByText('Your comments go straight to the Lumen Studio team.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download original/u })).toHaveAttribute(
      'href',
      `${BASE}/v1/organizations/northstar/portal/files/f1/content`,
    );
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('a client pins a comment: no audience switch, the team line, and a client-visible post', async () => {
    const { client, calls } = fakeApi();
    renderPortal(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    const art = sizeTheArtwork();

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    fireEvent.pointerDown(art, { button: 0, clientX: 500, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(art, { button: 0, clientX: 500, clientY: 250, pointerId: 1 });

    const dialog = await screen.findByRole('dialog', { name: 'New comment' });
    expect(within(dialog).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('Everyone on the Lumen Studio team will see this.'),
    ).toBeInTheDocument();
    const box = within(dialog).getByRole('textbox');
    expect(box).toHaveAttribute('placeholder', 'Tell the team what to change');

    // The @mention list is the team the client is talking to.
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } });
    expect(await within(dialog).findByText('Omar Adel')).toBeInTheDocument();
    expect(within(dialog).queryByText('Sara Nabil')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/portal/projects/p1/review/mention-candidates'))).toBe(
      true,
    );

    fireEvent.change(box, { target: { value: 'Make the button bigger.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/portal/files/f1/review/threads'),
      );
      expect(post?.body).toMatchObject({
        versionId: 'fv2',
        anchorKind: 'pin',
        anchor: { x: 0.5, y: 0.5 },
        audience: 'client_visible',
        body: 'Make the button bigger.',
      });
    });
  });

  it('a client replies and resolves through the portal thread routes', async () => {
    const { client, calls } = fakeApi();
    renderPortal(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    sizeTheArtwork();

    fireEvent.click(await screen.findByRole('button', { name: 'Comment 1, open' }));
    await screen.findByRole('heading', { name: 'Comment 1' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Thanks, looks good.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.endsWith('/portal/review/threads/t1/comments'),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.endsWith('/portal/review/threads/t1/resolve'),
        ),
      ).toBe(true),
    );
  });

  it('a deliverable version carries the decision card; changes need a note; approve calls the existing route', async () => {
    const { client, calls } = fakeApi();
    renderPortal(client, { deliverableVersionId: 'dv1' });

    const card = await screen.findByRole('region', { name: 'Your decision' });
    expect(await within(card).findByText('8f2c·d41a')).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Request changes' }));
    expect(await within(card).findByRole('alert')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/decision'))).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: /Approve this version/u }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/decision'));
      expect(post?.url).toBe(
        `${BASE}/v1/organizations/northstar/approvals/projections/dv1/decision`,
      );
      expect(post?.body).toEqual({ decision: 'approve' });
    });
    expect(
      await within(card).findByText('Approved by you. You can still comment with questions.'),
    ).toBeInTheDocument();
  });

  it('a version only shared (never sent for approval) opens without a decision card', async () => {
    const { client, calls } = fakeApi({ ...APPROVAL, awaitingDecision: false });
    renderPortal(client, { deliverableVersionId: 'dv1' });
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/approvals/projections/dv1'))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Your decision' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Approve this version/u })).not.toBeInTheDocument();
  });

  it('a team member’s preview reads as the client: team-only hidden and counted, nothing to write or decide', async () => {
    const { client, calls } = fakeApi();
    renderPortal(client, { preview: true, deliverableVersionId: 'dv1' });
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    sizeTheArtwork();

    expect((await screen.findAllByText('Client preview')).length).toBeGreaterThan(0);
    expect(
      await screen.findByText('2 team-only comments are hidden here. Clients never see them.'),
    ).toBeInTheDocument();
    const list = screen.getByRole('listbox', { name: 'Comments on this file' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Comment 2, open' })).not.toBeInTheDocument();

    // The team's own routes, never the client's (a team member is refused there).
    expect(calls.some((c) => c.url.includes('/portal/files/'))).toBe(false);
    // No comment tools, and the decision buttons disabled with the reason.
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
    const card = await screen.findByRole('region', { name: 'Your decision' });
    expect(within(card).getByRole('button', { name: /Approve this version/u })).toBeDisabled();
    expect(
      within(card).getByText(
        'Only Seaside Hotels can approve or request changes. You are previewing.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Comment 1, open' }));
    await screen.findByRole('heading', { name: 'Comment 1' });
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('Arabic: the chrome is right-to-left and the pin stays where it is on the artwork', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { client } = fakeApi();
    renderPortal(client);
    await screen.findByRole('img', { name: 'homepage-concept-v2.png' });
    sizeTheArtwork();
    const pins = document.querySelectorAll<HTMLElement>('.tm-viewer-pin');
    expect(pins.length).toBeGreaterThan(0);
    expect(pins[0]?.style.left).toBe('25%');
    expect(screen.getByText('تصل تعليقاتك مباشرة إلى فريق Lumen Studio.')).toBeInTheDocument();
  });
});

describe('portal viewer helpers', () => {
  it('links a file to the portal viewer, with the deliverable version when there is one', () => {
    expect(portalFileViewerHref('northstar', 'f 1')).toBe('/northstar/portal/files/f%201');
    expect(portalFileViewerHref('northstar', 'f1', 'dv1')).toBe(
      '/northstar/portal/files/f1?deliverableVersionId=dv1',
    );
  });

  it('a client preview keeps client-visible threads only, with nothing actionable', () => {
    const seen = threadsAsClientSees(TEAM_THREADS as unknown as ReviewThread[]);
    expect(seen.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(seen.every((t) => !t.canResolve && !t.canMove)).toBe(true);
    expect(seen.flatMap((t) => t.comments).every((c) => !c.canEdit && !c.canDelete)).toBe(true);
  });

  it('says what was decided', () => {
    expect(decisionShown('approved', null)).toBe('approved');
    expect(decisionShown('changes_requested', null)).toBe('changes');
    expect(decisionShown('requested', null)).toBe('recorded');
    expect(decisionShown(null, 'changes_requested')).toBe('changes');
    expect(decisionShown(null, 'approved')).toBe('approved');
    expect(decisionShown(null, null)).toBe(null);
  });
});

describe('portal entry points (V-44)', () => {
  it('the Files table shows the open comments and a Review button for a file the viewer can show', async () => {
    const api = new ApiClient({
      baseUrl: BASE,
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes('/files')
          ? {
              files: [
                {
                  id: 'file-1',
                  projectId: 'proj-1',
                  name: 'homepage.png',
                  sizeBytes: 2048,
                  contentType: 'image/png',
                  uploadedAt: '2026-09-19T00:00:00.000Z',
                  scanStatus: 'clean',
                  reviewable: true,
                  openComments: 3,
                },
                {
                  id: 'file-2',
                  projectId: 'proj-1',
                  name: 'notes.bin',
                  sizeBytes: 10,
                  contentType: 'application/octet-stream',
                  uploadedAt: '2026-09-19T00:00:00.000Z',
                  scanStatus: 'clean',
                  reviewable: false,
                  openComments: 0,
                },
              ],
            }
          : {
              projects: [
                {
                  id: 'proj-1',
                  name: 'Atlas Website',
                  status: 'active',
                  committedAt: null,
                  forecastAt: null,
                },
              ],
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const { PortalFilesScreen } = await import('../src/components/screens/PortalFilesScreen');
    render(
      withQuery(
        <PortalFilesScreen
          organizationSlug="northstar"
          clientName="Seaside Hotels"
          providerName="Lumen Studio"
          client={api}
        />,
      ),
    );
    const review = await screen.findByRole('link', { name: 'Review homepage.png' });
    expect(review).toHaveAttribute('href', '/northstar/portal/files/file-1');
    expect(screen.getByRole('columnheader', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByText('3 open')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review notes.bin' })).not.toBeInTheDocument();
  });
});
