import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilesHubScreen } from '../src/components/screens/FilesHubScreen';
import { ApiClient } from '../src/lib/api/client';
import { UploadFailedError } from '../src/lib/api/uploads';
import type * as Uploads from '../src/lib/api/uploads';

const uploadProjectFile = vi.hoisted(() =>
  vi.fn((..._args: readonly unknown[]) => Promise.resolve('uploaded-file')),
);
vi.mock('../src/lib/api/uploads', async (original) => ({
  ...(await original<typeof Uploads>()),
  uploadProjectFile,
}));

/**
 * FIX3 item 11 (live check a6f66e47 F2): `/files` was a 404. The Files hub (FIL-01) lists every
 * project's ready files, newest first, and each row opens the file in its viewer.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function file(id: string, projectId: string, name: string, updatedAt: string) {
  return {
    id,
    projectId,
    name,
    mimeType: 'text/csv',
    sizeBytes: 42,
    audience: 'internal',
    purpose: 'deliverable',
    versionNo: 1,
    updatedAt,
  };
}

function apiClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files')) return Promise.resolve(json({ files: [] }));
      return Promise.resolve(
        json({
          projects: [
            { id: 'p1', name: 'Atlas' },
            { id: 'p2', name: 'Borealis' },
          ],
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function dropFiles(target: Element, files: readonly File[]) {
  const dataTransfer = { files, types: ['Files'] };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe('Files hub (FIX3 item 11)', () => {
  it('D6: `?client=` narrows the hub to the projects shared with that company, with the way back', async () => {
    const asked: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const url = String(input);
        asked.push(url);
        if (url.includes('/client-organizations/co-1/projects')) {
          return Promise.resolve(json({ projects: [{ id: 'p2', name: 'Borealis' }] }));
        }
        if (url.includes('/client-organizations/co-1')) {
          return Promise.resolve(json({ id: 'co-1', name: 'Cedar Foods' }));
        }
        if (url.includes('/files')) return Promise.resolve(json({ files: [] }));
        return Promise.resolve(
          json({
            projects: [
              { id: 'p1', name: 'Atlas' },
              { id: 'p2', name: 'Borealis' },
            ],
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen
          organizationSlug="acme"
          organizationName="Acme"
          clientOrganizationId="co-1"
          client={client}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Borealis' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Atlas' })).toBeNull();
    expect((await screen.findByText('Cedar Foods')).tagName).toBe('BDI');
    expect(screen.getByRole('link', { name: 'Show all' }).getAttribute('href')).toBe('/acme/files');
    await waitFor(() => expect(asked.some((url) => url.includes('/projects/p2/'))).toBe(true));
    expect(asked.some((url) => url.includes('/projects/p1/'))).toBe(false);
  });

  it('FIX6 item 7: dropped files upload into the chosen project; with several projects it asks for one first', async () => {
    uploadProjectFile.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={apiClient()} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeTruthy();
    await screen.findByText('No files yet');
    const page = document.querySelector('.tm-dx--drop');
    if (!page) throw new Error('no drop area');
    const brief = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });

    dropFiles(page, [brief]);
    expect(await screen.findByText('Choose a project first')).toBeTruthy();
    // QA-FIX S7 (2026-11-20): the dropped file is held, not dropped on the floor, and says so.
    expect(screen.getByText(/your 1 file\(s\) upload there/u)).toBeTruthy();
    expect(uploadProjectFile).not.toHaveBeenCalled();

    // Picking the project sends the held file; nothing has to be dropped twice.
    fireEvent.click(screen.getByRole('button', { name: 'Borealis' }));
    await waitFor(() => expect(uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(uploadProjectFile.mock.calls[0]?.[1]).toBe('acme');
    expect(uploadProjectFile.mock.calls[0]?.[2]).toMatchObject({ projectId: 'p2', file: brief });
    expect(screen.queryByText('Choose a project first')).toBeNull();
  });

  // QA-FIX S5, S8, S9 (2026-11-20): a refused file keeps a row that says why; nothing vanishes.
  it('refuses an oversized file before sending, and names a type refusal as not a virus finding', async () => {
    uploadProjectFile.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={apiClient()} />
      </QueryClientProvider>,
    );
    await screen.findByText('No files yet');
    const page = document.querySelector('.tm-dx--drop');
    if (!page) throw new Error('no drop area');
    fireEvent.click(screen.getByRole('button', { name: 'Borealis' }));

    const big = new File(['x'], 'film.mov', { type: 'video/quicktime' });
    Object.defineProperty(big, 'size', { value: 200 * 1024 * 1024 });
    dropFiles(page, [big]);
    expect(await screen.findByText(/“film\.mov” is larger than 100 MB/u)).toBeTruthy();
    expect(uploadProjectFile).not.toHaveBeenCalled();

    uploadProjectFile.mockImplementationOnce(() =>
      Promise.reject(new UploadFailedError('rejected', 'logo.php.jpg', null, null, 'file_type')),
    );
    dropFiles(page, [new File(['png'], 'logo.php.jpg', { type: 'image/jpeg' })]);
    expect(await screen.findByText(/This was not a virus finding/u)).toBeTruthy();
    expect(screen.queryByText('No files yet')).toBeNull();
  });

  it('lists all projects’ files newest first, each linking to its viewer', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/projects/p1/files')) {
          return Promise.resolve(
            json({ files: [file('f1', 'p1', 'table.csv', '2026-11-09T09:00:00.000Z')] }),
          );
        }
        if (url.includes('/projects/p2/files')) {
          return Promise.resolve(
            json({ files: [file('f2', 'p2', 'brief.csv', '2026-11-09T10:00:00.000Z')] }),
          );
        }
        return Promise.resolve(
          json({
            projects: [
              { id: 'p1', name: 'Atlas' },
              { id: 'p2', name: 'Borealis' },
            ],
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
      </QueryClientProvider>,
    );
    const newest = await screen.findByRole('link', { name: 'brief.csv' });
    expect(newest.getAttribute('href')).toBe('/acme/files/f2');
    const links = screen.getAllByRole('link').filter((link) => link.textContent?.endsWith('.csv'));
    expect(links.map((link) => link.textContent)).toEqual(['brief.csv', 'table.csv']);
    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeTruthy();
  });
});
