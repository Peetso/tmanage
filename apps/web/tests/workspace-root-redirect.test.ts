import { describe, expect, it, vi } from 'vitest';

import WorkspaceRootPage from '../src/app/[orgSlug]/page';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

/** The bare workspace address (where sign-up used to land on "page not found") opens Home. */
describe('workspace root /{slug}', () => {
  it('redirects to the workspace home', async () => {
    await expect(
      WorkspaceRootPage({ params: Promise.resolve({ orgSlug: 'nile-studio' }) }),
    ).rejects.toThrow('NEXT_REDIRECT /nile-studio/home');
    expect(redirect).toHaveBeenCalledWith('/nile-studio/home');
  });
});
