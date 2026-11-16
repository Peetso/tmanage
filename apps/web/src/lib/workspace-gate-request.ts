import { cookies, headers } from 'next/headers';
import { REQUEST_PATH_HEADER } from './request-path';
import { sessionHint, workspaceGate, type WorkspaceGate } from './workspace-gate';

/**
 * {@link workspaceGate} for the current request: the `[orgSlug]` layout and the bare `/{slug}`
 * page both ask it, because Next renders a layout and its page side by side and the page must
 * not redirect where the layout answers 404.
 */
export async function requestWorkspaceGate(slug: string): Promise<WorkspaceGate> {
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  return workspaceGate({
    slug,
    pathname: requestHeaders.get(REQUEST_PATH_HEADER),
    hasSession: sessionHint((name) => requestCookies.has(name), requestHeaders.get('host')),
  });
}
