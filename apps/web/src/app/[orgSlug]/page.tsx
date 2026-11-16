import { notFound, redirect } from 'next/navigation';
import { requestWorkspaceGate } from '../../lib/workspace-gate-request';

/**
 * The bare workspace address (`/{slug}`) has no screen of its own: the workspace's first
 * destination is **Home** (`/{slug}/home`, the rail's brand link). Without this page a person
 * who typed or was sent the bare address — e.g. straight after sign-up — saw "page not found".
 * It asks the same gate as the layout, which renders beside this page, not before it: a segment
 * that is not a workspace address (`/wp-admin`, SOFT404) and a signed-out bare `/{x}`
 * (AGENTREADY) are a 404 here, not a redirect to `/{x}/home`.
 */
export default async function WorkspaceRootPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<never> {
  const { orgSlug } = await params;
  const gate = await requestWorkspaceGate(orgSlug);
  if (gate.kind === 'not-found') notFound();
  if (gate.kind === 'sign-in') redirect(gate.location);
  redirect(`/${encodeURIComponent(orgSlug)}/home`);
}
