import { redirect } from 'next/navigation';

/**
 * The bare workspace address (`/{slug}`) has no screen of its own: the workspace's first
 * destination is **Home** (`/{slug}/home`, the rail's brand link). Without this page a person
 * who typed or was sent the bare address — e.g. straight after sign-up — saw "page not found".
 */
export default async function WorkspaceRootPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<never> {
  const { orgSlug } = await params;
  redirect(`/${encodeURIComponent(orgSlug)}/home`);
}
