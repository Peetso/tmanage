import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DriveAttachPicker } from '../src/components/storage/DriveAttachPicker';
import type { ApiClient } from '../src/lib/api/client';
import { getProjectDriveFiles } from '../src/lib/api/google-drive';
import { openDrivePicker } from '../src/lib/google-picker';

vi.mock('../src/lib/google-picker', () => ({
  openDrivePicker: vi.fn(async () => []),
}));

/**
 * Wave 11 Q1, NV10: a project-scoped member gets no Drive token (`mode: 'scoped'`). "Attach from
 * Google Drive" then lists the project's own TManage folders from the API and never opens Google's
 * picker; what the person ticks reaches `onPick` exactly as picked files did before.
 */
const BASE = '/v1/organizations/north/integrations/google-drive';
const PROJECT = '7d3c1f9a-2b4e-4c6d-8e0f-1a2b3c4d5e6f';
const FILES = `${BASE}/projects/${PROJECT}/files`;

function scopedClient(): { client: ApiClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async ({ path }: { path: string }) => {
    if (path.includes('picker-session')) return { data: { mode: 'scoped', projectId: PROJECT } };
    if (path.startsWith(FILES)) {
      const inItem = path.includes('folderId=folder_item_a');
      return {
        data: {
          folderId: inItem ? 'folder_item_a' : 'folder_pa',
          folders: [
            { id: 'folder_pa', kind: 'project', name: 'Project A' },
            { id: 'folder_item_a', kind: 'work_item', name: 'Homepage copy' },
          ],
          files: inItem
            ? [
                {
                  id: 'file_in_item_1',
                  name: 'Draft.docx',
                  mimeType: 'application/msword',
                  size: 9,
                  modifiedTime: null,
                  isFolder: false,
                },
              ]
            : [
                {
                  id: 'file_brief_1',
                  name: 'Brief.pdf',
                  mimeType: 'application/pdf',
                  size: 5,
                  modifiedTime: null,
                  isFolder: false,
                },
                {
                  id: 'folder_item_a',
                  name: 'Homepage copy',
                  mimeType: 'application/vnd.google-apps.folder',
                  size: null,
                  modifiedTime: null,
                  isFolder: true,
                },
              ],
          nextPageToken: null,
        },
      };
    }
    return { data: { pickerAvailable: true, googleDrive: { status: 'connected' } } };
  });
  return { client: { request } as unknown as ApiClient, request };
}

function wrap(children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

describe('scoped Drive attach (NV10)', () => {
  it('opens the project files dialog, never the Google picker, and hands the ticks to onPick', async () => {
    const { client, request } = scopedClient();
    const onPick = vi.fn();
    render(
      wrap(
        <DriveAttachPicker
          organizationSlug="north"
          client={client}
          picked={[]}
          onPick={onPick}
          onRemove={() => undefined}
          projectId={PROJECT}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Attach from Google Drive' }));

    const dialog = await screen.findByRole('dialog', { name: 'Attach from project files' });
    expect(dialog).toBeTruthy();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Brief.pdf' }));
    // A folder is never offered as a file to tick.
    expect(screen.queryByRole('checkbox', { name: 'Homepage copy' })).toBeNull();

    // Drill into the work item's folder and tick a file there too.
    fireEvent.click(screen.getByRole('button', { name: 'Homepage copy' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Draft.docx' }));
    expect(request.mock.calls.map((call) => call[0]?.path)).toContain(
      `${FILES}?folderId=folder_item_a`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Attach selected' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick).toHaveBeenCalledWith([
      { id: 'file_brief_1', name: 'Brief.pdf' },
      { id: 'file_in_item_1', name: 'Draft.docx' },
    ]);
    expect(openDrivePicker).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('builds the files path with only the folder and page token it is given', async () => {
    const { client, request } = scopedClient();
    await getProjectDriveFiles(client, 'north', PROJECT);
    await getProjectDriveFiles(client, 'north', PROJECT, {
      folderId: 'folder_item_a',
      pageToken: 'next_1',
    });
    expect(request.mock.calls.map((call) => call[0]?.path)).toEqual([
      FILES,
      `${FILES}?folderId=folder_item_a&pageToken=next_1`,
    ]);
  });
});
