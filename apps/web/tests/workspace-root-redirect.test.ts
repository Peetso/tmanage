import { describe, expect, it, vi } from 'vitest';

import WorkspaceRootPage from '../src/app/[orgSlug]/page';

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ redirect, notFound }));

/** The bare workspace address (where sign-up used to land on "page not found") opens Home. */
describe('workspace root /{slug}', () => {
  it('redirects to the workspace home', async () => {
    await expect(
      WorkspaceRootPage({ params: Promise.resolve({ orgSlug: 'nile-studio' }) }),
    ).rejects.toThrow('NEXT_REDIRECT /nile-studio/home');
    expect(redirect).toHaveBeenCalledWith('/nile-studio/home');
  });

  it.each(['wp-admin', 'debug', '_debug', 'elmah.axd', 'server-status', 'wp-login.php'])(
    'answers 404 for the scanner path /%s instead of redirecting to its home',
    async (orgSlug) => {
      await expect(WorkspaceRootPage({ params: Promise.resolve({ orgSlug }) })).rejects.toThrow(
        'NEXT_NOT_FOUND',
      );
      expect(redirect).not.toHaveBeenCalledWith(`/${orgSlug}/home`);
    },
  );
});
