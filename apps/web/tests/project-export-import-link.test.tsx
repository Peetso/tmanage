import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ImportLink } from '../src/components/projects/ImportLink';
import { ProjectExportButton } from '../src/components/projects/ProjectExportButton';
import { switchStartHref } from '../src/components/website/pages/compare/ComparePage';
import { SWITCH_ENTRIES } from '../src/content/compare/switch-entries';
import { ApiClient } from '../src/lib/api/client';
import { projectExportPath } from '../src/lib/api/projects';
import {
  allowedImportTool,
  importPagePath,
  importToolFromSearch,
  withImportTool,
} from '../src/lib/import-link';
import { afterSignInPath } from '../src/lib/sign-in-return';

/**
 * 54-29 — the project Export menu's visibility, the `?import=<tool>` allow-list from the switch
 * pages through sign-in to the Import page, and the IMPORTLINK entry on the portfolio. The API's
 * permission and tenant refusals are proven in `project-export.controller.test.ts`.
 */

function clientOver(handler: (url: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const PROJECT = { id: 'p-1', name: 'Rebrand' };

function me(capabilities: string[]) {
  return clientOver((url) =>
    url.endsWith('/v1/organizations/northstar/me')
      ? json({ membershipId: 'm', userId: 'u', kind: 'internal', role: 'manager', capabilities })
      : json({}, 404),
  );
}

describe('?import=<tool> allow-list', () => {
  it('keeps only exact tool ids', () => {
    expect(allowedImportTool('jira')).toBe('jira');
    for (const bad of [
      'JIRA',
      'jira/',
      '//evil.example',
      'https://evil.example',
      '',
      null,
      undefined,
    ]) {
      expect(allowedImportTool(bad)).toBeUndefined();
    }
    expect(importToolFromSearch('?import=clickup&x=1')).toBe('clickup');
    expect(importToolFromSearch('?import=%2F%2Fevil.example')).toBeUndefined();
  });

  it('builds same-origin paths only', () => {
    expect(withImportTool('/sign-up', 'monday')).toBe('/sign-up?import=monday');
    expect(withImportTool('/sign-up', 'javascript:alert(1)')).toBe('/sign-up');
    expect(importPagePath('north star', 'asana')).toBe(
      '/north%20star/onboarding/import?import=asana',
    );
    expect(importPagePath('northstar')).toBe('/northstar/onboarding/import');
  });

  it('every switch page CTA carries its own tool', () => {
    for (const entry of SWITCH_ENTRIES) {
      expect(switchStartHref(entry)).toMatch(
        new RegExp(`^/sign-(up|in)\\?import=${entry.source}$`),
      );
    }
  });

  it('sign-in carries the tool to the chooser, and an allowed ?next= still wins', () => {
    expect(afterSignInPath(null, '?import=trello')).toBe('/organizations?import=trello');
    expect(afterSignInPath(null, '?import=https://evil.example')).toBe('/organizations');
    expect(afterSignInPath('//evil.example', '?import=notion')).toBe(
      '/organizations?import=notion',
    );
    expect(afterSignInPath('/platform', '?import=notion')).toBe('/platform');
  });
});

describe('project Export menu', () => {
  it('is shown with work.export and offers CSV and JSON download links', async () => {
    render(
      withQuery(
        <ProjectExportButton
          organizationSlug="northstar"
          project={PROJECT}
          client={me(['work.read', 'work.export'])}
          apiOrigin="https://api.example.test"
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      `https://api.example.test${projectExportPath('northstar', 'p-1', 'csv')}`,
      `https://api.example.test${projectExportPath('northstar', 'p-1', 'json')}`,
    ]);
  });

  it('is absent without work.export', async () => {
    const client = me(['work.read']);
    render(
      withQuery(
        <ProjectExportButton organizationSlug="northstar" project={PROJECT} client={client} />,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('says so when the server refuses the download', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    render(
      withQuery(
        <ProjectExportButton
          organizationSlug="northstar"
          project={PROJECT}
          client={me(['work.export'])}
          apiOrigin="https://api.example.test"
          fetchImpl={fetchImpl as unknown as typeof globalThis.fetch}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getAllByRole('menuitem')[0]!);
    expect(await screen.findByText(/The export did not download/)).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/organizations/northstar/projects/p-1/export?format=csv',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('IMPORTLINK', () => {
  function orgs(role: string) {
    return clientOver((url) =>
      url.endsWith('/v1/organizations')
        ? json({
            organizations: [{ slug: 'northstar', name: 'Northstar', role, audience: 'internal' }],
          })
        : json({}, 404),
    );
  }

  it('links an owner to the Import page', async () => {
    render(withQuery(<ImportLink organizationSlug="northstar" client={orgs('owner')} />));
    const link = await screen.findByRole('link', { name: 'Import' });
    expect(link.getAttribute('href')).toBe('/northstar/onboarding/import');
  });

  it('is absent for a member, whom every import route refuses', async () => {
    render(withQuery(<ImportLink organizationSlug="northstar" client={orgs('member')} />));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Import' })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
  });
});
