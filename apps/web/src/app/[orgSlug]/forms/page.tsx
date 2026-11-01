import { redirect } from 'next/navigation';

/**
 * 2026-10-31 live-test fix: `/{slug}/forms` was "page not found". Intake forms live under Work
 * (`/{slug}/work/forms`); a person who types or is sent the short address lands there.
 */
export default async function FormsShortcutPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<never> {
  const { orgSlug } = await params;
  redirect(`/${encodeURIComponent(orgSlug)}/work/forms`);
}
