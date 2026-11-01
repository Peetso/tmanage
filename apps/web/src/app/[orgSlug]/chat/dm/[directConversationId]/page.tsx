import { redirect } from 'next/navigation';

/**
 * R7: a direct conversation is a `conversations` row with the same id (0276), so the old DM link
 * goes to the one conversation route.
 */
export default async function DirectMessagePage({
  params,
}: {
  params: Promise<{ orgSlug: string; directConversationId: string }>;
}) {
  const { orgSlug, directConversationId } = await params;
  redirect(`/${encodeURIComponent(orgSlug)}/chat/${encodeURIComponent(directConversationId)}`);
}
