import type { ApiClient } from './client';
import { createConversation, type ConversationSummary } from './conversations';

/**
 * R7 slice 3 — group chats: info, settings, members, admin roles, leave and invite links. The API
 * is `…/conversations/:id/group` (admins change it, members read it) and `…/chat/invites/:token`
 * (team members preview and join; clients never join by link).
 */

export type GroupRole = 'admin' | 'member';

export interface GroupMember {
  readonly userId: string;
  readonly displayName: string;
  readonly role: GroupRole;
  readonly isClient: boolean;
  readonly joinedAt: string;
}

export interface GroupInfo {
  readonly conversationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly photoFileAssetId: string | null;
  readonly onlyAdminsCanSend: boolean;
  readonly viewerRole: GroupRole;
  /** Admins only; null when no link is live. */
  readonly inviteToken: string | null;
  readonly members: readonly GroupMember[];
}

export interface GroupSettingsInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly photoFileAssetId?: string | null;
  readonly onlyAdminsCanSend?: boolean;
}

export interface GroupInvitePreview {
  readonly conversationId: string;
  readonly name: string;
  readonly photoFileAssetId: string | null;
  readonly memberCount: number;
  readonly alreadyMember: boolean;
}

/** The `meta` of a `kind = 'system'` message (written by the API, never by a person). */
export interface GroupSystemMeta {
  readonly event: string;
  readonly userIds: readonly string[];
}

const org = (slug: string) => `/v1/organizations/${encodeURIComponent(slug)}`;
const group = (slug: string, id: string) =>
  `${org(slug)}/conversations/${encodeURIComponent(id)}/group`;

export const groupKeys = {
  info: (slug: string, id: string) => ['chat-groups', slug, id] as const,
  invite: (slug: string, token: string) => ['chat-groups', slug, 'invite', token] as const,
};

export async function getGroupInfo(api: ApiClient, slug: string, id: string): Promise<GroupInfo> {
  return (await api.request<GroupInfo>({ path: group(slug, id) })).data;
}

export async function updateGroup(
  api: ApiClient,
  slug: string,
  id: string,
  input: GroupSettingsInput,
): Promise<GroupInfo> {
  return (await api.request<GroupInfo>({ method: 'PATCH', path: group(slug, id), body: input }))
    .data;
}

export async function addGroupMember(
  api: ApiClient,
  slug: string,
  id: string,
  userId: string,
): Promise<GroupInfo> {
  const path = `${group(slug, id)}/members`;
  return (await api.request<GroupInfo>({ method: 'POST', path, body: { userId } })).data;
}

export async function removeGroupMember(
  api: ApiClient,
  slug: string,
  id: string,
  userId: string,
): Promise<void> {
  const path = `${group(slug, id)}/members/${encodeURIComponent(userId)}`;
  await api.request({ method: 'DELETE', path });
}

export async function setGroupMemberRole(
  api: ApiClient,
  slug: string,
  id: string,
  userId: string,
  role: GroupRole,
): Promise<GroupInfo> {
  const path = `${group(slug, id)}/members/${encodeURIComponent(userId)}/role`;
  return (await api.request<GroupInfo>({ method: 'PUT', path, body: { role } })).data;
}

export async function leaveGroup(api: ApiClient, slug: string, id: string): Promise<void> {
  await api.request({ method: 'POST', path: `${group(slug, id)}/leave` });
}

export async function createGroupInvite(api: ApiClient, slug: string, id: string): Promise<string> {
  const path = `${group(slug, id)}/invite`;
  return (await api.request<{ inviteToken: string }>({ method: 'POST', path })).data.inviteToken;
}

export async function revokeGroupInvite(api: ApiClient, slug: string, id: string): Promise<void> {
  await api.request({ method: 'DELETE', path: `${group(slug, id)}/invite` });
}

export async function previewGroupInvite(
  api: ApiClient,
  slug: string,
  token: string,
): Promise<GroupInvitePreview> {
  const path = `${org(slug)}/chat/invites/${encodeURIComponent(token)}`;
  return (await api.request<GroupInvitePreview>({ path })).data;
}

export async function joinGroupInvite(
  api: ApiClient,
  slug: string,
  token: string,
): Promise<string> {
  const path = `${org(slug)}/chat/invites/${encodeURIComponent(token)}/join`;
  return (await api.request<{ conversationId: string }>({ method: 'POST', path })).data
    .conversationId;
}

/**
 * Create a group, then set its photo and add each picked person (each add posts "X added Y").
 *
 * R38 G1: with no `projectId` (the default, "General") the group belongs to no project: its
 * members are the creator and the people picked. With a `projectId` it is that project's channel:
 * the project team joins it, as for any channel, so nobody is added one by one.
 */
export async function createGroup(
  api: ApiClient,
  slug: string,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly photoFileAssetId?: string;
    readonly memberUserIds: readonly string[];
    readonly projectId?: string;
  },
): Promise<ConversationSummary> {
  if (input.projectId !== undefined) {
    const channel = await createConversation(api, slug, {
      projectId: input.projectId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
    });
    return channel;
  }
  const created = await createConversation(api, slug, {
    kind: 'group',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
  });
  if (input.photoFileAssetId) {
    await updateGroup(api, slug, created.id, { photoFileAssetId: input.photoFileAssetId });
  }
  for (const userId of input.memberUserIds) {
    await addGroupMember(api, slug, created.id, userId);
  }
  return created;
}

/** The shareable link a group's invite token opens (the studio route that previews and joins). */
export function inviteLinkFor(origin: string, slug: string, token: string): string {
  return `${origin}/${encodeURIComponent(slug)}/chat/invite/${encodeURIComponent(token)}`;
}
