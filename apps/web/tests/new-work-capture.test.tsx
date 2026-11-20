import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { QuickCaptureScreen } from '../src/components/screens/QuickCaptureScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * **New work: project, labels and attachments** (Peter, 2026-10-18 — "there's no attachment
 * feature or tag it in project").
 *
 * The capsule now opens on the project the person came from, lists the organization's labels as
 * toggles, takes files, and after creating the item assigns each chosen label and uploads and
 * attaches each file to it. The API's own authorization and the upload protocol are proved
 * elsewhere (`apps/api`, `work-attachments-upload.test.ts`); this file proves the screen sends the
 * right writes, in the right order, to the right item and project.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PROJECTS = [
  { id: 'proj-a', name: 'Atlas Website Relaunch' },
  { id: 'proj-b', name: 'Northstar Brand Refresh' },
];

function world(options: { failAttach?: boolean } = {}) {
  const calls: Call[] = [];
  const labels = [
    { id: 'lab-1', name: 'Copy review', color: 'gray', createdAt: '2026-10-18T09:00:00.000Z' },
  ];
  const client = new ApiClient({
    baseUrl: 'https://app.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, method, body });
      const path = new URL(url).pathname;
      if (method === 'GET' && path.endsWith('/projects'))
        return Promise.resolve(json({ projects: PROJECTS }));
      if (method === 'GET' && path.endsWith('/work/labels'))
        return Promise.resolve(json({ labels }));
      if (method === 'POST' && path.endsWith('/work/labels')) {
        const created = {
          id: 'lab-new',
          name: (body as { name: string }).name,
          color: 'gray',
          createdAt: '2026-10-18T09:00:00.000Z',
        };
        labels.push(created);
        return Promise.resolve(json(created, 201));
      }
      if (method === 'POST' && path.endsWith('/work-items')) {
        const input = body as { projectId: string; title: string };
        return Promise.resolve(
          json({ id: 'item-1', projectId: input.projectId, title: input.title }, 201),
        );
      }
      if (method === 'PUT' && path.endsWith('/work-items/item-1/labels')) {
        return Promise.resolve(
          json({
            id: 'il-1',
            workItemId: 'item-1',
            labelId: (body as { labelId: string }).labelId,
          }),
        );
      }
      if (method === 'POST' && path.endsWith('/upload-sessions')) {
        return Promise.resolve(
          json(
            {
              id: 'us-1',
              fileAssetId: 'fa-1',
              partSizeBytes: 8,
              uploadUrls: [
                { partNumber: 1, url: 'https://app.example.test/v1/uploads/x/parts/1?t=s' },
              ],
            },
            201,
          ),
        );
      }
      if (method === 'POST' && path.endsWith('/complete'))
        return Promise.resolve(json({ id: 'fa-1', status: 'uploaded' }, 202));
      if (method === 'POST' && path.endsWith('/work-items/item-1/files')) {
        if (options.failAttach) {
          return Promise.resolve(
            json(
              { error: { code: 'not_found', message: 'The requested resource was not found' } },
              404,
            ),
          );
        }
        return Promise.resolve(
          json(
            { id: 'if-1', workItemId: 'item-1', fileAssetId: 'fa-1', fileName: 'brief.pdf' },
            201,
          ),
        );
      }
      return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const partFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: undefined,
    });
    return Promise.resolve(new Response(null, { status: 200, headers: { etag: '"e1"' } }));
  }) as typeof globalThis.fetch;
  return { client, calls, partFetch };
}

function withQuery(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderCapture(w: ReturnType<typeof world>, initialProjectId?: string) {
  return render(
    withQuery(
      <QuickCaptureScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={w.client}
        uploadOptions={{ fetch: w.partFetch, newKey: () => 'key-0123456789abcdef' }}
        {...(initialProjectId ? { initialProjectId } : {})}
      />,
    ),
  );
}

/** 55-08: labels, files and the note sit behind "More options"; open it when it is closed. */
async function openMoreOptions(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole('button', { name: /More options|Fewer options/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}

describe('New work capsule', () => {
  it('opens on the project the person came from, and requires a project', async () => {
    renderCapture(world(), 'proj-b');
    const project = await screen.findByLabelText(/^Project/);
    expect(project).toHaveValue('proj-b');
    expect(project).toBeRequired();
  });

  it('does not preselect a project when the handed-over one is not the person’s (WRK-09)', async () => {
    // CQ-07 (WRK-09): a project the caller cannot see is ignored, and nothing stands in for it —
    // the field opens on the "Choose a project…" prompt rather than the first project in the org.
    renderCapture(world(), 'proj-elsewhere');
    expect(await screen.findByLabelText(/^Project/)).toHaveValue('');
  });

  it('QA-FIX-R M2: Capture without a project says what is missing and sends nothing', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w);
    await user.type(await screen.findByLabelText(/^Title/), 'Check the hero copy');
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    expect(await screen.findByText('Choose the project this work belongs to.')).toBeInTheDocument();
    expect(w.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('files the item in the chosen project, then labels it and uploads and attaches the file', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w, 'proj-b');

    await user.type(await screen.findByLabelText(/^Title/), 'Check the hero copy');
    await openMoreOptions(user);
    await user.click(await screen.findByRole('button', { name: 'Copy review' }));
    expect(screen.getByRole('button', { name: 'Copy review' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const file = new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, file);
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/was filed/);
    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      '/northstar/work/item-1',
    );

    const writes = w.calls
      .filter((call) => call.method !== 'GET')
      .map((call) => `${call.method} ${new URL(call.url).pathname}`);
    expect(writes).toEqual([
      'POST /v1/organizations/northstar/work-items',
      'PUT /v1/organizations/northstar/work-items/item-1/labels',
      'POST /v1/organizations/northstar/upload-sessions',
      'PUT /v1/uploads/x/parts/1',
      'POST /v1/organizations/northstar/upload-sessions/us-1/complete',
      'POST /v1/organizations/northstar/work-items/item-1/files',
    ]);
    const bodies = w.calls.filter((call) => call.method !== 'GET').map((call) => call.body);
    expect(bodies[0]).toEqual({ projectId: 'proj-b', title: 'Check the hero copy' });
    expect(bodies[1]).toEqual({ labelId: 'lab-1' });
    expect(bodies[2]).toMatchObject({
      projectId: 'proj-b',
      fileName: 'brief.pdf',
      purpose: 'deliverable',
    });
    expect(bodies[5]).toEqual({ fileAssetId: 'fa-1' });
  });

  it('defines a new label in place and selects it', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w);
    await openMoreOptions(user);
    await user.click(await screen.findByRole('button', { name: '+ New label' }));
    await user.type(screen.getByLabelText('New label name'), 'Launch{Enter}');
    const created = await screen.findByRole('button', { name: 'Launch' });
    await waitFor(() => expect(created).toHaveAttribute('aria-pressed', 'true'));
    expect(
      w.calls.find((call) => call.method === 'POST' && call.url.endsWith('/work/labels'))?.body,
    ).toEqual({
      name: 'Launch',
      color: 'gray',
    });
  });

  it('refuses a file type TManage does not accept before any upload', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const w = world();
    renderCapture(w);
    await screen.findByLabelText(/^Project/);
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByText(/not a file type TManage accepts/)).toBeInTheDocument();
    expect(screen.queryByText('setup.exe')).toBeNull();
  });

  it('keeps the filed item and names the file that could not be attached', async () => {
    const user = userEvent.setup();
    const w = world({ failAttach: true });
    renderCapture(w, 'proj-b');
    await user.type(await screen.findByLabelText(/^Title/), 'Brief');
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    await screen.findByText(/was filed/);
    expect(await screen.findByText(/“brief.pdf” was not attached/)).toBeInTheDocument();
  });
});
