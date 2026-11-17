import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkspaceLayout from '../src/app/[orgSlug]/layout';
import { sessionCookieVisible, workspaceGate } from '../src/lib/workspace-gate';

const state = vi.hoisted(() => ({ path: null as string | null, csrf: false }));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      host: 'tmanageapp.com',
      ...(state.path === null ? {} : { 'x-tmanage-path': state.path }),
    }),
  cookies: async () => ({ has: (name: string) => state.csrf && name === 'tmanage_session_csrf' }),
}));
vi.mock('../src/components/brand/BrandAccentStyle', () => ({ BrandAccentStyle: () => null }));

const SCANNER_SLUGS = [
  'wp-admin',
  'wp-login.php',
  'debug',
  '_debug',
  'elmah.axd',
  'server-status',
  '.well-known',
  'phpmyadmin',
  'cgi-bin',
  'actuator',
  'admin',
  'api',
  'v1',
];

async function renderLayout(orgSlug: string): Promise<unknown> {
  return WorkspaceLayout({ children: null, params: Promise.resolve({ orgSlug }) });
}

/** SOFT404 (live 2026-11-15): an unknown first segment was served the signed-in shell with 200. */
describe('workspace gate', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    state.path = null;
    state.csrf = false;
  });

  it.each(SCANNER_SLUGS)('answers 404 for /%s, signed in or not', async (slug) => {
    for (const csrf of [false, true]) {
      state.csrf = csrf;
      state.path = `/${slug}/home`;
      await expect(renderLayout(slug)).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });

  it('sends a signed-out visitor to sign-in instead of the shell', async () => {
    state.path = '/anything/home';
    await expect(renderLayout('anything')).rejects.toThrow('NEXT_REDIRECT /sign-in');
  });

  it('renders the shell when the session cookie is present', async () => {
    state.csrf = true;
    state.path = '/nile-studio/home';
    await expect(renderLayout('nile-studio')).resolves.toBeTruthy();
  });

  it('keeps the AI approve page as the return path and the portal sign-in open', () => {
    const id = '0190b3c4-1111-7222-8333-944455556666';
    expect(
      workspaceGate({ slug: 'nile', pathname: `/nile/ai/approve/${id}`, hasSession: false }),
    ).toEqual({
      kind: 'sign-in',
      location: `/sign-in?next=${encodeURIComponent(`/nile/ai/approve/${id}`)}`,
    });
    expect(
      workspaceGate({ slug: 'nile', pathname: '/nile/portal/sign-in', hasSession: false }),
    ).toEqual({ kind: 'open' });
    expect(
      workspaceGate({ slug: 'nile', pathname: '/nile/portal/files', hasSession: false }),
    ).toEqual({ kind: 'sign-in', location: '/nile/portal/sign-in' });
  });

  it('ignores a path header that is not under the slug', () => {
    expect(
      workspaceGate({ slug: 'nile', pathname: '/other/portal/sign-in', hasSession: false }),
    ).toEqual({ kind: 'sign-in', location: '/sign-in' });
  });

  it('sees the cookie only for a same-origin or same-host API', () => {
    expect(sessionCookieVisible('', 'tmanageapp.com')).toBe(true);
    expect(sessionCookieVisible('http://localhost:3001', 'localhost:3000')).toBe(true);
    expect(sessionCookieVisible('https://api.example.com', 'app.example.org')).toBe(false);
  });
});
