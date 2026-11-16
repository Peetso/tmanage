import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { BrandAccentStyle } from '../../components/brand/BrandAccentStyle';
import { requestWorkspaceGate } from '../../lib/workspace-gate-request';

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
  const gate = await requestWorkspaceGate(orgSlug);
  if (gate.kind === 'not-found') notFound();
  if (gate.kind === 'sign-in') redirect(gate.location);
  return (
    <>
      <BrandAccentStyle organizationSlug={orgSlug} />
      {children}
    </>
  );
}
