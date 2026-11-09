import type { ReactNode } from 'react';
import { BrandAccentStyle } from '../../components/brand/BrandAccentStyle';

/**
 * Every workspace screen: the company's own brand colour, when the owner has set one, repaints
 * the accent tokens (Peter 2026-11-09).
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <>
      <BrandAccentStyle organizationSlug={orgSlug} />
      {children}
    </>
  );
}
