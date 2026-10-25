import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DriveAttachPicker } from '../src/components/storage/DriveAttachPicker';
import type { ApiClient } from '../src/lib/api/client';
import { getPickerSession } from '../src/lib/api/google-drive';

vi.mock('../src/lib/google-picker', () => ({
  openDrivePicker: vi.fn(async () => []),
}));

/**
 * Wave 9, NV10 follow-up: the API mints a picker token without a project only for an org-wide
 * caller (owner/admin). The New work sheet must name the chosen project, or every ordinary member
 * gets a 403 the moment they press "Attach from Google Drive".
 */
const PICKER = '/v1/organizations/north/integrations/google-drive/picker-session';
const PROJECT = '7d3c1f9a-2b4e-4c6d-8e0f-1a2b3c4d5e6f';

function connectedClient(): { client: ApiClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async ({ path }: { path: string }) =>
    path.includes('picker-session')
      ? { data: { accessToken: 'token', developerKey: 'key', appId: 'app' } }
      : { data: { pickerAvailable: true, googleDrive: { status: 'connected' } } },
  );
  return { client: { request } as unknown as ApiClient, request };
}

function wrap(children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

describe('Drive picker session names the project (NV10)', () => {
  it('appends the project to the picker-session path', async () => {
    const { client, request } = connectedClient();
    await getPickerSession(client, 'north', PROJECT);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ path: `${PICKER}?projectId=${PROJECT}` });
  });

  it('keeps the bare path for the org-wide admin screen', async () => {
    const { client, request } = connectedClient();
    await getPickerSession(client, 'north');
    expect(request.mock.calls[0]?.[0]).toMatchObject({ path: PICKER });
  });

  it('is disabled until a project is chosen', async () => {
    const { client } = connectedClient();
    render(
      wrap(
        <DriveAttachPicker
          organizationSlug="north"
          client={client}
          picked={[]}
          onPick={() => undefined}
          onRemove={() => undefined}
          projectId=""
        />,
      ),
    );
    const button = await screen.findByRole('button', { name: 'Attach from Google Drive' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for the token of the chosen project', async () => {
    const { client, request } = connectedClient();
    render(
      wrap(
        <DriveAttachPicker
          organizationSlug="north"
          client={client}
          picked={[]}
          onPick={() => undefined}
          onRemove={() => undefined}
          projectId={PROJECT}
        />,
      ),
    );
    const button = await screen.findByRole('button', { name: 'Attach from Google Drive' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(request.mock.calls.map((call) => call[0]?.path)).toContain(
        `${PICKER}?projectId=${PROJECT}`,
      ),
    );
    expect(request.mock.calls.map((call) => call[0]?.path)).not.toContain(PICKER);
  });
});
