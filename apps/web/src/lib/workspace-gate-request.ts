import { cookies, headers } from 'next/headers';
import { resolveApiBaseUrl, resolveCsrfCookieName } from './public-config';
import { REQUEST_PATH_HEADER } from './request-path';
import { sessionCookieVisible, workspaceGate, type WorkspaceGate } from './workspace-gate';

/**
 * {@link workspaceGate} for the current request: the `[orgSlug]` layout and the bare `/{slug}`
 * page both ask it, because Next renders a layout and its page side by side and the page must
 * not redirect where the layout answers 404.
 */
export async function requestWorkspaceGate(slug: string): Promise<WorkspaceGate> {
  const environment = {
    nodeEnv: process.env.NODE_ENV,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    sessionCookieName: process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  };
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  return workspaceGate({
    slug,
    pathname: requestHeaders.get(REQUEST_PATH_HEADER),
    hasSession:
      requestCookies.has(resolveCsrfCookieName(environment)) ||
      !sessionCookieVisible(resolveApiBaseUrl(environment), requestHeaders.get('host')),
  });
}
