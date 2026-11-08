import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TemplatePacksGallery } from '../src/components/projects/TemplatePacksGallery';
import { ApiClient } from '../src/lib/api/client';
import type { TemplatePackView } from '../src/lib/api/template-packs';

/** 54-22 — the template packs gallery: what the cards show and what the install confirm sends. */

function pack(partial: Partial<TemplatePackView>): TemplatePackView {
  return {
    key: 'agency-client-launch',
    name: 'Agency client launch',
    description: 'Kick-off, brand sprint and website launch for a new client.',
    roles: ['agency_owner', 'project_manager', 'designer'],
    language: 'en',
    workWeek: 'mon_fri',
    templateNames: ['Client kick-off', 'Brand sprint', 'Website launch'],
    docs: ['Client onboarding guide', 'Creative brief'],
    automations: ['Tell the client when a milestone is done', 'Remind the lead'],
    installed: false,
    installedAt: null,
    ...partial,
  };
}

function mount(packs: readonly TemplatePackView[]) {
  const calls: { method: string; url: string }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(input) });
      const body =
        method === 'POST'
          ? { pack: { ...packs[0], installed: true }, templatesCreated: 3, templatesSkipped: 0 }
          : { packs };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: method === 'POST' ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <TemplatePacksGallery api={client} organizationSlug="northstar" />
    </QueryClientProvider>,
  );
  return calls;
}

describe('TemplatePacksGallery (54-22)', () => {
  it('shows each pack with its contents, and Installed instead of the button once installed', async () => {
    mount([
      pack({}),
      pack({
        key: 'monthly-retainer',
        name: 'Monthly retainer',
        installed: true,
        templateNames: ['Monthly retainer'],
        docs: ['Report'],
        automations: ['Next month'],
      }),
    ]);
    expect(await screen.findByText('Agency client launch')).toBeTruthy();
    expect(screen.getByText('3 project templates · 2 docs · 2 automations')).toBeTruthy();
    expect(screen.getByText('1 project template · 1 doc · 1 automation')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Install pack' })).toHaveLength(1);
    expect(screen.getByText('Installed')).toBeTruthy();
  });

  it('confirms the templates a pack adds and installs it', async () => {
    const calls = mount([pack({})]);
    fireEvent.click(await screen.findByRole('button', { name: 'Install pack' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Brand sprint')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install pack' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toContainEqual({
      method: 'POST',
      url: 'https://api.example.test/v1/organizations/northstar/projects/templates/packs/agency-client-launch/install',
    });
    expect(await screen.findByText('3 templates added to this workspace.')).toBeTruthy();
  });
});
