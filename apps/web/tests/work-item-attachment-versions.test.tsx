import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkItemDetailScreen } from '../src/components/screens/WorkItemDetailScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * C7 — version history for a plain (not deliverable-backed) attachment on the work item's Files
 * card: the history block, the current version served by the file's Download, a previous version
 * downloaded by its own file id, and "Upload new version" recording the upload against the
 * attachment's root file.
 */
const L = (key: string, vars: Record<string, string | number> = {}) => {
  let text = translate('en-US', key as MessageKey);
  for (const [name, value] of Object.entries(vars))
    text = text.split(`{${name}}`).join(String(value));
  return text;
};

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ITEM = {
  id: 'wi-1',
  projectId: 'proj-1',
  type: 'task',
  title: 'Homepage hero copy',
  description: null,
  state: 'in_progress',
  ownerUserId: 'user-1',
  audience: 'internal',
  startAt: null,
  dueAt: null,
  completedAt: null,
  version: 3,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  deletedAt: null,
};

const version = (n: number, fileAssetId: string, current: boolean) => ({
  versionNo: n,
  fileAssetId,
  fileName: 'hero-copy.docx',
  availability: 'ready',
  note: null,
  createdByUserId: n === 1 ? 'user-1' : 'user-omar',
  createdAt: `2026-10-2${n}T10:00:00.000Z`,
  current,
});

function renderDetail(versions: readonly ReturnType<typeof version>[]) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('https://api.example.test', '').split('?')[0] ?? '';
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path, method, body });
      if (method === 'POST' && path.endsWith('/upload-sessions')) {
        return Promise.resolve(
          json({
            id: 'session-1',
            fileAssetId: 'asset-3',
            partSizeBytes: 1024,
            uploadUrls: [{ partNumber: 1, url: 'https://api.example.test/v1/uploads/p1' }],
          }),
        );
      }
      if (method === 'POST' && path.endsWith('/complete')) {
        // FIX6 item 1: the upload is used only once the API says the file is usable (here: passed
        // the checks under the owner's policy, no scanner), as on live.
        return Promise.resolve(json({ id: 'asset-3', status: 'uploaded', usable: true }));
      }
      if (method === 'POST' && path.endsWith('/files/asset-1/versions')) {
        return Promise.resolve(json({ rootFileAssetId: 'asset-1', versions }, 201));
      }
      if (path.endsWith('/files/asset-1/versions')) {
        return Promise.resolve(json({ rootFileAssetId: 'asset-1', versions }));
      }
      if (path.endsWith('/members')) {
        return Promise.resolve(
          json({
            members: [
              { userId: 'user-1', displayName: 'Mona Saleh', role: 'member', status: 'active' },
              { userId: 'user-omar', displayName: 'Omar Nabil', role: 'manager', status: 'active' },
            ],
            nextAfter: null,
          }),
        );
      }
      if (path.endsWith('/projects')) {
        return Promise.resolve(json({ projects: [{ id: 'proj-1', name: 'Website relaunch' }] }));
      }
      if (path.endsWith('/work-items/wi-1')) return Promise.resolve(json(ITEM));
      if (path.endsWith('/work-items/wi-1/files')) {
        return Promise.resolve(
          json({
            files: [
              {
                id: 'link-1',
                workItemId: 'wi-1',
                fileAssetId: 'asset-1',
                fileName: 'hero-copy.docx',
                availability: 'ready',
                attachedByMembershipId: 'm-1',
                createdAt: '2026-10-21T10:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path.endsWith('/activity')) return Promise.resolve(json({ activity: [] }));
      if (path.endsWith('/checklist')) return Promise.resolve(json({ items: [] }));
      if (path.endsWith('/deliverables')) return Promise.resolve(json({ deliverables: [] }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <WorkItemDetailScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        workItemId="wi-1"
        client={client}
        onDeleted={vi.fn()}
        onOpenItem={vi.fn()}
        now={new Date(2026, 9, 23, 9, 0, 0)}
      />
    </QueryClientProvider>,
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

async function openFilePanel() {
  fireEvent.click(
    await screen.findByRole('button', { name: L('WorkFiles.moreFor', { name: 'hero-copy.docx' }) }),
  );
}

describe('C7 plain attachment version history', () => {
  it('lists the versions, serves the current one and downloads a previous one by its own id', async () => {
    renderDetail([version(2, 'asset-2', true), version(1, 'asset-1', false)]);
    // WX2: the file is a chip; its ⌄ panel holds the actions and the history.
    await openFilePanel();
    const title = await screen.findByText(L('WorkDetail.versionHistory'));
    const history = title.closest('.tm-wk-history') as HTMLElement;
    expect(within(history).getByText(L('WorkDetail.versionCurrent', { n: 2 }))).toBeInTheDocument();
    expect(
      within(history).getByText(L('WorkDetail.versionBy', { n: 1, name: 'Mona Saleh' })),
    ).toBeInTheDocument();
    const previous = within(history).getByRole('link', { name: L('WorkDetail.download') });
    expect(previous.getAttribute('href')).toMatch(/\/files\/asset-1\/content$/);
    const links = screen.getAllByRole('link', { name: L('WorkDetail.download') });
    expect(
      links.some((link) => /\/files\/asset-2\/content$/.test(link.getAttribute('href') ?? '')),
    ).toBe(true);
  });

  it('draws no history for a single version, and records an uploaded file as the next version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200, headers: { etag: '"e1"' } }))),
    );
    const { calls } = renderDetail([version(1, 'asset-1', true)]);
    await openFilePanel();
    const upload = await screen.findByRole('button', { name: L('WorkDetail.uploadVersion') });
    expect(screen.queryByText(L('WorkDetail.versionHistory'))).toBeNull();
    fireEvent.click(upload);
    const pickers = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const picker = pickers[pickers.length - 1] as HTMLInputElement;
    const file = new File(['new copy'], 'hero-copy.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() =>
      expect(
        calls.find(
          (call) => call.method === 'POST' && call.path.endsWith('/files/asset-1/versions'),
        )?.body,
      ).toEqual({ fileAssetId: 'asset-3' }),
    );
  });
});
