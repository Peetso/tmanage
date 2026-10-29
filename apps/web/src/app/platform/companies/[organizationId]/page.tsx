import { redirect } from 'next/navigation';

/** The v1 address of one organization; v2 lives at /platform/organizations/[id]. */
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  redirect(`/platform/organizations/${encodeURIComponent(organizationId)}`);
}
