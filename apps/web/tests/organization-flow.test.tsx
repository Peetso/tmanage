import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CreateOrganizationScreen } from '../src/components/screens/CreateOrganizationScreen';
import { OperatingTemplateScreen } from '../src/components/screens/OperatingTemplateScreen';
import { OrganizationSelectorScreen } from '../src/components/screens/OrganizationSelectorScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * `ID-04` and `ON-01` against the endpoints TEN-001's second half delivered.
 *
 * The API's own behaviour — the provisioning transaction, the directory's scoping — is proved
 * in `apps/api/test/ten-001-provisioning.db.test.ts` against a real server. What only this
 * file can prove is what the two screens do with the answers, and in particular that the rule
 * `22-SCREEN-BY-SCREEN` §3 states for `ID-04` survives the round trip:
 *
 * > No cross-organization aggregated content in MVP.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const NORTHSTAR = {
  id: 'org-1',
  slug: 'northstar',
  name: 'Northstar Studio',
  audience: 'internal' as const,
  role: 'project_manager',
  clientOrganizationName: null,
};

const ATLAS = {
  id: 'org-2',
  slug: 'northstar',
  name: 'Northstar Studio',
  audience: 'client' as const,
  role: 'client_viewer',
  clientOrganizationName: 'Atlas Hospitality',
};

describe('ID-04 organization selector', () => {
  it('fetches the list and renders one row per membership', async () => {
    const { client, calls } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    render(withQuery(<OrganizationSelectorScreen client={client} />));

    await screen.findByLabelText('Search organizations');
    expect(calls[0]?.url).toBe('https://api.example.test/v1/organizations');
    expect(calls[0]?.method ?? 'GET').toBe('GET');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('leads a client row with the client organization’s own name', async () => {
    // Alongside an internal org so the list renders — a lone client org is taken straight in,
    // which the next test covers.
    const { client } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    const navigate = vi.fn();
    render(withQuery(<OrganizationSelectorScreen client={client} navigate={navigate} />));

    expect(await screen.findByText('Atlas Hospitality')).toBeInTheDocument();
    expect(screen.getByText('Client portal')).toBeInTheDocument();
    // The delivery team is named, but underneath.
    expect(screen.getByText(/Delivered by Northstar Studio/)).toBeInTheDocument();
  });

  /**
   * ACC-12: a client cannot create an organization and has only their portal to go to, so a
   * client with a single organization is taken straight in rather than made to pick it from a
   * list of one.
   */
  it('takes a client with one organization straight into their portal', async () => {
    const { client } = clientOver(() => json({ organizations: [ATLAS] }));
    const navigate = vi.fn();
    render(withQuery(<OrganizationSelectorScreen client={client} navigate={navigate} />));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/northstar/portal'));
    expect(screen.queryByLabelText('Search organizations')).toBeNull();
  });

  /** An internal member with one organization still sees the chooser (to create another). */
  it('still shows the chooser for an internal member with one organization', async () => {
    const { client } = clientOver(() => json({ organizations: [NORTHSTAR] }));
    const navigate = vi.fn();
    render(withQuery(<OrganizationSelectorScreen client={client} navigate={navigate} />));

    await screen.findByLabelText('Search organizations');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends a client row to the portal and an internal row to the app', async () => {
    const { client } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    render(withQuery(<OrganizationSelectorScreen client={client} />));

    await screen.findByLabelText('Search organizations');
    const links = within(screen.getByRole('list'))
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(links).toContain('/northstar/home');
    expect(links).toContain('/northstar/portal');
  });

  /**
   * `22` §3's rule, asserted against a rendered screen rather than against the repository
   * that could not produce the aggregate in the first place. Two independent places, because
   * this is the sentence the whole screen exists to obey.
   */
  it('renders no number that spans organizations', async () => {
    const { client } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    const { container } = render(withQuery(<OrganizationSelectorScreen client={client} />));

    await screen.findByLabelText('Search organizations');
    // The only count on the screen is the heading's count of organizations themselves, which
    // is a fact about the list rather than about their contents.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '2 organizations use your email',
    );
    expect(container.textContent).not.toMatch(/across your organizations/i);
    expect(container.textContent).not.toMatch(/\d+\s+(open|items|projects) in total/i);
  });

  it('filters in the browser, sending nothing', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    render(withQuery(<OrganizationSelectorScreen client={client} />));

    await screen.findByLabelText('Search organizations');
    const before = calls.length;

    await user.type(screen.getByLabelText('Search organizations'), 'zzz');
    expect(screen.getByText(/No organization matches/)).toBeInTheDocument();
    expect(calls).toHaveLength(before);
  });

  /** Not an error. It is what everyone sees between signing up and founding something. */
  it('offers a way forward when the list is empty', async () => {
    const { client } = clientOver(() => json({ organizations: [] }));
    render(withQuery(<OrganizationSelectorScreen client={client} />));

    expect(await screen.findByText('You are not in an organization yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an organization' })).toHaveAttribute(
      'href',
      '/onboarding/organization',
    );
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  /**
   * ACC-15: a removed member arrives with `?removed` and an empty list. They used to be offered
   * "Create an organization" as though they had never joined one; they are now told their access
   * was removed.
   */
  it('tells a removed member their access was removed, not to create an organization', async () => {
    const originalSearch = window.location.search;
    window.history.replaceState({}, '', '/organizations?removed');
    try {
      const { client } = clientOver(() => json({ organizations: [] }));
      render(withQuery(<OrganizationSelectorScreen client={client} />));

      expect(await screen.findByText(/removed by an administrator/)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull();
    } finally {
      window.history.replaceState({}, '', `/organizations${originalSearch}`);
    }
  });

  it('reports a refusal instead of an empty list', async () => {
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'The request carries no valid session',
            correlationId: 'c1',
          },
        },
        401,
      ),
    );
    render(withQuery(<OrganizationSelectorScreen client={client} />));

    expect(await screen.findByText('Could not load your organizations')).toBeInTheDocument();
    expect(screen.queryByText('You are not in an organization yet')).toBeNull();
  });

  it('has no axe violations once loaded', async () => {
    const { client } = clientOver(() => json({ organizations: [NORTHSTAR, ATLAS] }));
    const { container } = render(withQuery(<OrganizationSelectorScreen client={client} />));
    await screen.findByLabelText('Search organizations');
    await expectNoAxeViolations(container);
  });
});

describe('ON-01 create organization', () => {
  const CREATED = {
    id: 'org-9',
    slug: 'lumen-works',
    name: 'Lumen Works',
    workspaceId: 'ws-9',
    role: 'owner',
  };

  async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, name = 'Lumen Works') {
    await user.type(screen.getByLabelText(/Organization name/), name);
    await user.click(screen.getByRole('button', { name: 'Create organization' }));
  }

  it('posts the derived slug and the collected fields', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const { client, calls } = clientOver(() => json(CREATED, 201));

    render(
      <CreateOrganizationScreen
        signedInAs="omar@northstar.studio"
        client={client}
        onCreated={onCreated}
      />,
    );
    await fillAndSubmit(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('lumen-works'));
    expect(calls[0]?.url).toBe('https://api.example.test/v1/organizations');
    expect(calls[0]?.method).toBe('POST');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['name']).toBe('Lumen Works');
    expect(body['slug']).toBe('lumen-works');
    expect(body['defaultLocale']).toBe('en');
    expect(typeof body['timezone']).toBe('string');
  });

  it('sends the CSRF token, because this one mutates', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('x-csrf-token') ?? '');
        return Promise.resolve(json(CREATED, 201));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'c',
    });

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await fillAndSubmit(user);

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe('csrf-token');
  });

  /**
   * A taken address is the one refusal that belongs beside the field rather than in a banner,
   * because there is exactly one input the person has to change.
   */
  it('attaches a taken address to the slug field', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'conflict',
            message: 'That web link is already taken',
            correlationId: 'c1',
            details: [
              { field: 'slug', message: 'That web link is taken. Choose a different one.' },
            ],
          },
        },
        409,
      ),
    );

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await fillAndSubmit(user);

    expect(
      await screen.findByText(/That web link is taken. Choose a different one/),
    ).toBeInTheDocument();
    // Not a banner.
    expect(screen.queryByText('Could not create the organization')).toBeNull();
  });

  it('clears a server field error when the address is edited', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            correlationId: 'c1',
            details: [
              { field: 'slug', message: 'That web link is taken. Choose a different one.' },
            ],
          },
        },
        409,
      ),
    );

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await fillAndSubmit(user);
    await screen.findByText(/That web link is taken. Choose a different one/);

    await user.type(screen.getByLabelText(/Workspace web link/), '-two');
    expect(screen.queryByText(/That web link is taken. Choose a different one/)).toBeNull();
  });

  it('shows a banner for a refusal with no field', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'The request carries no valid session',
            correlationId: 'c1',
          },
        },
        401,
      ),
    );

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await fillAndSubmit(user);

    expect(await screen.findByText('Could not create the organization')).toBeInTheDocument();
  });

  it('refuses to send an invalid address, and says which field', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(CREATED, 201));

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen');
    const slugField = screen.getByLabelText(/Workspace web link/);
    await user.clear(slugField);
    await user.type(slugField, 'Not Valid');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(calls).toHaveLength(0);
    expect(screen.getByText(/Fix the workspace web link first/)).toBeInTheDocument();
  });

  it('refuses an empty name without sending anything', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(CREATED, 201));

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(calls).toHaveLength(0);
    expect(screen.getByText(/Enter an organization name/)).toBeInTheDocument();
  });

  /**
   * The slug is sent as it appears in the field. The server refuses capitals rather than
   * folding them, so a screen that quietly lower-cased before posting would be showing an
   * address the person will not get.
   */
  it('sends the address exactly as the field shows it', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(CREATED, 201));

    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen Works');
    const shown = (screen.getByLabelText(/Workspace web link/) as HTMLInputElement).value;
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]?.body as { slug: string }).slug).toBe(shown);
  });

  it('has no axe violations', async () => {
    const { client } = clientOver(() => json(CREATED, 201));
    const { container } = render(
      <CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />,
    );
    await expectNoAxeViolations(container);
  });
});

describe('the two screens together', () => {
  /**
   * The list and the create screen agree about one thing that matters: the slug the create
   * screen sends is the slug the list will link to. Asserted rather than assumed, because the
   * two build the URL independently.
   */
  it('links to the slug that was created', async () => {
    const user = userEvent.setup();
    const created: string[] = [];
    const { client } = clientOver(() =>
      json(
        { id: 'org-9', slug: 'lumen-works', name: 'Lumen Works', workspaceId: 'w', role: 'owner' },
        201,
      ),
    );

    render(
      <CreateOrganizationScreen
        signedInAs="omar@northstar.studio"
        client={client}
        onCreated={(slug) => created.push(slug)}
      />,
    );
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen Works');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(created).toEqual(['lumen-works']));

    const listing = clientOver(() =>
      json({
        organizations: [
          {
            id: 'org-9',
            slug: created[0],
            name: 'Lumen Works',
            audience: 'internal',
            role: 'owner',
            clientOrganizationName: null,
          },
        ],
      }),
    );
    const { container } = render(withQuery(<OrganizationSelectorScreen client={listing.client} />));
    const link = await within(container).findByRole('link', { name: /Lumen Works/ });
    expect(link).toHaveAttribute('href', `/${created[0]}/home`);
  });
});

describe('ON-02 address check, working week and template', () => {
  const CREATED = { id: 'org-9', slug: 'lumen-works', name: 'L', workspaceId: 'w', role: 'owner' };

  it('checks the address once typing pauses and says it is available', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) =>
      call.url.includes('address-availability')
        ? json({ slug: 'lumen-works', available: true, reason: null, message: null })
        : json(CREATED, 201),
    );
    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen Works');

    expect(await screen.findByText('available')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.host}/`)).toBeInTheDocument();
    const checks = calls.filter((call) => call.url.includes('address-availability'));
    // Debounced: one check for the paused-on address, not one per keystroke.
    expect(checks.map((call) => call.url)).toEqual([
      'https://api.example.test/v1/organizations/address-availability?slug=lumen-works',
    ]);
  });

  it('puts a taken address beside the field and refuses to submit it', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() =>
      json({
        slug: 'lumen-works',
        available: false,
        reason: 'taken',
        message: 'That web link is already taken.',
      }),
    );
    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen Works');
    expect(await screen.findByText(/already taken/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(screen.getByText(/Fix the workspace web link first/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the working week and the template the work type implies', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(CREATED, 201));
    render(<CreateOrganizationScreen signedInAs="omar@northstar.studio" client={client} />);
    await user.click(screen.getByRole('radio', { name: /Retainer and support work/ }));
    await user.selectOptions(screen.getByLabelText('Working week'), 'sun-thu');
    await user.type(screen.getByLabelText(/Organization name/), 'Lumen Works');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body['workingWeek']).toBe('sun-thu');
    expect(body['operatingTemplate']).toBe('intake-commitment');
  });

  it('starts on the saved template and saves the chosen one before moving on', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const { client, calls } = clientOver(() =>
      json({ settings: [{ key: 'operating_template', value: 'internal-delivery' }] }),
    );
    render(
      <OperatingTemplateScreen
        signedInAs="omar@northstar.studio"
        organizationSlug="lumen-works"
        client={client}
        onContinue={onContinue}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Internal delivery/ })).toBeChecked(),
    );
    await user.click(screen.getByRole('radio', { name: /Intake and commitment/ }));
    await user.click(screen.getByRole('button', { name: 'Use this template' }));

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe(
      'https://api.example.test/v1/organizations/lumen-works/settings/operating_template',
    );
    expect(put?.body).toEqual({ value: 'intake-commitment' });
  });
});
