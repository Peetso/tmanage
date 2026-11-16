import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAddressableWorkspaceSlug } from '@tmanage/domain';
import { NextRequest } from 'next/server';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import NotFound from '../src/app/not-found';
import { proxy } from '../src/proxy';

vi.mock('next/navigation', () => ({
  usePathname: () => '/this-page-does-not-exist-xyz',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://tmanage.peetrix.com${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

/**
 * NOTFOUND (live 2026-11-16): a signed-out bare `/{x}` answered 404 with an EMPTY body: the
 * `[orgSlug]` layout's `notFound()` reaches the browser only as client-drawn data. The proxy now
 * answers it with the prerendered not-found page, status 404.
 */
describe('a signed-out unknown bare path', () => {
  it('is answered with the full not-found page and status 404', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    const response = proxy(request('/this-page-does-not-exist-xyz'));
    const html = renderToString(<NotFound />);
    expect([
      response.status,
      response.headers.get('x-middleware-rewrite'),
      html.includes('find that page'),
      html.includes('href="/sign-in"'),
    ]).toEqual([404, 'https://tmanage.peetrix.com/_not-found', true, true]);
  });

  it('leaves public pages, signed-in visitors and deep links alone', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    expect(
      [
        proxy(request('/pricing')),
        proxy(request('/compare')),
        proxy(request('/nile-studio', 'tmanage_session_csrf=x')),
        proxy(request('/nile-studio/home')),
      ].map((response) => response.headers.get('x-middleware-rewrite')),
    ).toEqual([null, null, null, null]);
  });

  it('never takes a static top-level route for a workspace address', () => {
    const app = join(process.cwd(), 'src/app');
    const routes = readdirSync(app, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        entry.name.startsWith('(')
          ? readdirSync(join(app, entry.name), { withFileTypes: true })
              .filter((inner) => inner.isDirectory())
              .map((inner) => inner.name)
          : [entry.name],
      )
      .filter((name) => !name.startsWith('['));
    expect(routes.filter((name) => isAddressableWorkspaceSlug(name))).toEqual([]);
  });
});
