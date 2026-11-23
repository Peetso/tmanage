import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { QuickCaptureScreen } from '../src/components/screens/QuickCaptureScreen';
import { NewWorkDialog } from '../src/components/work/create/NewWorkDialog';
import { ApiClient } from '../src/lib/api/client';

/**
 * **New work** (W-WEB-3; before it, Peter 2026-10-18: "there's no attachment feature or tag it in
 * project").
 *
 * Full create (the `/capture` page) opens on the project the person came from, takes doers, a
 * supervisor, a client and steps into the one create body, and after creating the item assigns
 * each chosen label and uploads and attaches each file to it. Quick create (the dialog) grows into
 * full create without losing what was typed. The API's own authorization and the upload protocol
 * are proved elsewhere (`apps/api`, `work-attachments-upload.test.ts`); this file proves the form
 * sends the right writes, in the right order, to the right item and project.
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

const PEOPLE = [
  { userId: 'u-peter', displayName: 'Peter Kamal', role: 'member' },
  { userId: 'u-sara', displayName: 'Sara Adel', role: 'member' },
  { userId: 'u-laila', displayName: 'Laila Hassan', role: 'manager' },
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
      if (method === 'GET' && path.endsWith('/projects/proj-b/members'))
        return Promise.resolve(
          json({
            members: PEOPLE.map((person, index) => ({
              projectMembershipId: `pm-${index}`,
              userId: person.userId,
              role: 'member',
              createdAt: '',
            })),
          }),
        );
      if (method === 'GET' && path.endsWith('/members'))
        return Promise.resolve(json({ members: PEOPLE, nextAfter: null }));
      if (method === 'GET' && path.endsWith('/projects/proj-b/clients'))
        return Promise.resolve(
          json({
            clients: [
              { id: 's-1', projectId: 'proj-b', clientOrganizationId: 'c-nile', createdAt: '' },
            ],
          }),
        );
      if (method === 'GET' && path.endsWith('/client-organization-options'))
        return Promise.resolve(
          json({ clientOrganizations: [{ id: 'c-nile', name: 'Nile Foods' }] }),
        );
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

/** Open one property's editor (full create: the field named by its row label and value). */
async function openField(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(await screen.findByRole('button', { name: label }));
}

/** The form's own Create (the page's header Create is the phone's; jsdom draws both). */
async function pressCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Create' })[0] as HTMLElement);
}

describe('New work (full create as a page)', () => {
  it('opens on the project the person came from', async () => {
    renderCapture(world(), 'proj-b');
    expect(
      await screen.findByRole('button', { name: /^Project Northstar Brand Refresh/ }),
    ).toBeInTheDocument();
  });

  it('does not preselect a project when the handed-over one is not the person’s (WRK-09)', async () => {
    renderCapture(world(), 'proj-elsewhere');
    expect(await screen.findByRole('button', { name: /^Project Choose a project/ })).toBeVisible();
  });

  it('QA-FIX-R M2: Create without a project says what is missing and sends nothing', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w);
    await user.type(await screen.findByLabelText('Work name'), 'Check the hero copy');
    await pressCreate(user);
    expect(await screen.findByText('Choose the project this work belongs to.')).toBeInTheDocument();
    expect(w.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('sends doers, supervisor, client and steps in the one create body', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w, 'proj-b');
    await user.type(await screen.findByLabelText('Work name'), 'Design the landing page');

    await openField(user, /^Doers/);
    await user.click(await screen.findByRole('checkbox', { name: /Peter Kamal/ }));
    await user.click(screen.getByRole('checkbox', { name: /Sara Adel/ }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await openField(user, /^Supervisor/);
    await user.click(await screen.findByRole('checkbox', { name: /Laila Hassan/ }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await openField(user, /^Client/);
    await user.click(await screen.findByRole('button', { name: 'Nile Foods' }));
    await user.keyboard('{Escape}');

    const step = screen.getByPlaceholderText('Add a step, press Enter');
    await user.type(step, 'Collect references{Enter}');
    await user.type(step, 'Wireframe{Enter}');
    // Enter in the step box adds a step; it never sends the form.
    expect(w.calls.filter((call) => call.method !== 'GET')).toEqual([]);

    await pressCreate(user);
    await screen.findByText('Created');
    const create = w.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/work-items'),
    );
    expect(create?.body).toEqual({
      projectId: 'proj-b',
      title: 'Design the landing page',
      doerUserIds: ['u-peter', 'u-sara'],
      supervisorUserIds: ['u-laila'],
      audience: 'client_visible',
      clientOrganizationIds: ['c-nile'],
      steps: [{ label: 'Collect references' }, { label: 'Wireframe' }],
    });
  });

  it('files the item in the chosen project, then labels it and uploads and attaches the file', async () => {
    const user = userEvent.setup();
    const w = world();
    renderCapture(w, 'proj-b');

    await user.type(await screen.findByLabelText('Work name'), 'Check the hero copy');
    await openField(user, /^Labels/);
    await user.click(await screen.findByRole('button', { name: 'Copy review' }));
    expect(screen.getByRole('button', { name: 'Copy review' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.keyboard('{Escape}');

    await openField(user, /^Files/);
    const file = new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, file);
    expect(screen.getByText('brief.pdf')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await pressCreate(user);
    await screen.findByText('Created');
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
    await openField(user, /^Labels/);
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
    await openField(user, /^Files/);
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
    await user.type(await screen.findByLabelText('Work name'), 'Brief');
    await openField(user, /^Files/);
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' }));
    await user.keyboard('{Escape}');
    await pressCreate(user);
    await screen.findByText('Created');
    expect(await screen.findByText(/“brief.pdf” was not attached/)).toBeInTheDocument();
  });
});

describe('New work (quick create as a dialog)', () => {
  it('shows the six chips in the work page’s order and grows into full create, keeping the name', async () => {
    const user = userEvent.setup();
    const w = world();
    let closed = 0;
    render(
      withQuery(
        <NewWorkDialog
          organizationSlug="northstar"
          projectId="proj-b"
          client={w.client}
          onClose={() => (closed += 1)}
        />,
      ),
    );
    const dialog = await screen.findByRole('dialog', { name: 'New work' });
    const chips = await screen.findByRole('group', { name: 'Details of the new work' });
    const names = Array.from(chips.querySelectorAll('button')).map((chip) =>
      chip.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Project', 'Stage', 'Doers', 'Supervisor', 'Due', 'Client']);
    expect(screen.getByLabelText('Work name')).toHaveFocus();

    await user.type(screen.getByLabelText('Work name'), 'Plan the launch email');
    await user.click(screen.getByRole('button', { name: 'All fields' }));
    expect(screen.getByLabelText('Work name')).toHaveValue('Plan the launch email');
    expect(screen.getByPlaceholderText('Add a step, press Enter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and add another' })).toBeInTheDocument();

    // Escape inside an open editor closes the editor first, then the dialog.
    await user.click(screen.getByRole('button', { name: /^Project/ }));
    await user.keyboard('{Escape}');
    expect(closed).toBe(0);
    dialog.focus();
    await user.keyboard('{Escape}');
    expect(closed).toBe(1);
  });
});
