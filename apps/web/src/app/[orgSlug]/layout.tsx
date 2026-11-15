import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { BrandAccentStyle } from '../../components/brand/BrandAccentStyle';
import { resolveApiBaseUrl, resolveCsrfCookieName } from '../../lib/public-config';
import { REQUEST_PATH_HEADER } from '../../lib/request-path';
import { sessionCookieVisible, workspaceGate } from '../../lib/workspace-gate';

/**
 * Every workspace screen: the company's own brand colour, when the owner has set one, repaints
 * the accent tokens (Peter 2026-11-09).
 *
 * Before any of it renders, `workspaceGate` decides: a first segment that is not a workspace
 * address is a real 404, and a signed-out visitor goes to sign-in instead of being shown the
 * shell (SOFT404, 2026-11-15).
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const environment = {
    nodeEnv: process.env.NODE_ENV,
    apiBaseUrl: process.env['NEXT_PUBLIC_API_BASE_URL'],
    sessionCookieName: process.env['NEXT_PUBLIC_SESSION_COOKIE_NAME'],
  };
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const gate = workspaceGate({
    slug: orgSlug,
    pathname: requestHeaders.get(REQUEST_PATH_HEADER),
    hasSession:
      requestCookies.has(resolveCsrfCookieName(environment)) ||
      !sessionCookieVisible(resolveApiBaseUrl(environment), requestHeaders.get('host')),
  });
  if (gate.kind === 'not-found') notFound();
  if (gate.kind === 'sign-in') redirect(gate.location);
  return (
    <>
      <BrandAccentStyle organizationSlug={orgSlug} />
      {children}
    </>
  );
}
