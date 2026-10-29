import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoRequestForm } from '../src/components/website/pages/contact/DemoRequestForm';
import { ALL_RESOURCES } from '../src/components/website/pages/resources/resources-data';
import {
  FOOTER_COLUMNS,
  FOOTER_LEGAL,
  FOOTER_MOBILE_GROUPS,
  NAV_ACTIONS,
  NAV_ENTRIES,
} from '../src/components/website/site-nav';
import { ApiClient } from '../src/lib/api/client';

/**
 * **The public website (2026-10-18).**
 *
 * The site map is one file (`site-nav.ts`) read by the nav, the mega menus, the mobile drawer
 * and the footer. Every path it names must be a route that exists, so a link can never land on
 * a 404. Anchors are checked in a real browser by the build's link check, not here. The demo
 * form (`/contact`) is the site's one write: it posts to the existing public contact door.
 */

/** `process.cwd()` (the config leaves it at `apps/web`): jsdom gives no file `import.meta.url`. */
const APP = join(process.cwd(), 'src', 'app');

function routeFileFor(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const files = [
    join(APP, '(website)', ...segments, 'page.tsx'),
    join(APP, ...segments, 'page.tsx'),
  ];
  // `/resources/<slug>` is the dynamic article route; the slug must be a published article.
  if (segments[0] === 'resources' && segments.length === 2) {
    if (ALL_RESOURCES.some((item) => item.slug === segments[1])) {
      files.push(join(APP, '(website)', 'resources', '[slug]', 'page.tsx'));
    }
  }
  return files;
}

function allInternalHrefs(): string[] {
  const hrefs: string[] = [];
  for (const entry of NAV_ENTRIES) {
    if (entry.kind === 'link') hrefs.push(entry.href);
    else {
      for (const group of entry.menu.groups) hrefs.push(...group.links.map((l) => l.href));
      hrefs.push(entry.menu.featured.href);
    }
  }
  hrefs.push(...Object.values(NAV_ACTIONS).map((a) => a.href));
  for (const column of [...FOOTER_COLUMNS, ...FOOTER_MOBILE_GROUPS]) {
    hrefs.push(...column.links.map((l) => l.href));
  }
  hrefs.push(...FOOTER_LEGAL.map((l) => l.href));
  return [...new Set(hrefs)].filter((h) => h.startsWith('/'));
}

describe('website site map', () => {
  it.each(allInternalHrefs())('%s resolves to a route', (href) => {
    const path = href.split('#')[0]!;
    expect(routeFileFor(path).some((file) => existsSync(file))).toBe(true);
  });

  it('the mobile footer keeps every desktop footer link', () => {
    const desktop = FOOTER_COLUMNS.flatMap((c) => c.links.map((l) => l.href)).sort();
    const mobile = FOOTER_MOBILE_GROUPS.flatMap((c) => c.links.map((l) => l.href)).sort();
    expect(mobile).toEqual(desktop);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(status: number, body: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      // 52-21: the form fetches its invisible proof on mount; that GET is not a submission.
      if (String(input).includes('/public/form-proof')) return Promise.resolve(json({}, 200));
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(json(body, status));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

describe('website demo form', () => {
  it('posts the trimmed name and email, with the demo fields as message lines', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(201, { status: 'received' });
    render(<DemoRequestForm client={client} />);

    await waitFor(() => expect(screen.getByLabelText(/Full name/)).toBeEnabled());
    await user.type(screen.getByLabelText(/Full name/), '  Ada Lovelace  ');
    await user.type(screen.getByLabelText(/Work email/), ' ada@example.com ');
    await user.type(screen.getByLabelText(/Company/), 'Northwind');
    await user.selectOptions(screen.getByLabelText(/Team size/), '11–50');
    await user.click(screen.getByRole('button', { name: 'Book my demo' }));

    await waitFor(() =>
      expect(
        screen.getByText("Thanks — we'll be in touch within one business day."),
      ).toBeInTheDocument(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/public/site/contact');
    const sent = calls[0]!.body as { name: string; email: string; message: string };
    expect(sent.name).toBe('Ada Lovelace');
    expect(sent.email).toBe('ada@example.com');
    expect(sent.message).toContain('Company: Northwind');
    expect(sent.message).toContain('Team size: 11–50');
  });

  it('refuses a malformed email without calling the API', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(201, { status: 'received' });
    render(<DemoRequestForm client={client} />);

    await waitFor(() => expect(screen.getByLabelText(/Full name/)).toBeEnabled());
    await user.type(screen.getByLabelText(/Full name/), 'Ada');
    await user.type(screen.getByLabelText(/Work email/), 'not-an-email');
    await user.type(screen.getByLabelText(/Company/), 'Northwind');
    await user.selectOptions(screen.getByLabelText(/Team size/), '1–10');
    await user.click(screen.getByRole('button', { name: 'Book my demo' }));

    expect(await screen.findByText('Enter a work email like name@company.com.')).toBeVisible();
    expect(calls).toHaveLength(0);
  });
});
