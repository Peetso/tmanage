'use client';

import { useContext } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { Avatar } from '@tmanage/ui';
import type { AvatarProps } from '@tmanage/ui';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  fetchMyPhoto,
  fetchPeoplePhotos,
  myPhotoKey,
  myPhotoUrl,
  peoplePhotosKey,
  personPhotoUrl,
} from '../../lib/api/profile-photo';
import type { PhotoSize } from '../../lib/api/profile-photo';

/**
 * The one person avatar of the web app (owner, 2026-11-23). It draws the shared `@tmanage/ui`
 * `Avatar` and gives it the person's photo when they have one this viewer may see, so every place
 * a person is shown (rail, people, profile, chat, assignees, mentions, comments, the client portal)
 * shows the same picture, with the initials as the fallback.
 *
 * One read per workspace (`GET …/people-photos`, cached five minutes) feeds every avatar on the
 * page; the image URL carries the photo's version, so the browser caches each picture until it
 * changes. Without a query client (a story, a bare test) nothing is fetched and initials show.
 */

/** Stands in when no `QueryClientProvider` is mounted, so the hooks never throw; never fetches. */
const IDLE_QUERY_CLIENT = new QueryClient();
const FIVE_MINUTES = 5 * 60_000;

export interface PhotoRef {
  readonly userId: string;
  readonly version: string;
}

/**
 * `id → photo` for everyone in this workspace whose photo the viewer may see, keyed by user id and
 * by each membership id (some screens know a person only by their membership).
 */
export function usePeoplePhotos(organizationSlug: string): ReadonlyMap<string, PhotoRef> {
  const queryClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: peoplePhotosKey(organizationSlug),
      queryFn: () => fetchPeoplePhotos(browserApiClient(), organizationSlug),
      staleTime: FIVE_MINUTES,
      retry: false,
      enabled: queryClient !== undefined && organizationSlug !== '',
      select: (view) => {
        const byId = new Map<string, PhotoRef>();
        for (const p of view.photos) {
          const ref = { userId: p.userId, version: p.version };
          byId.set(p.userId, ref);
          for (const id of p.membershipIds) byId.set(id, ref);
        }
        return byId;
      },
    },
    queryClient ?? IDLE_QUERY_CLIENT,
  );
  return query.data ?? EMPTY;
}
const EMPTY: ReadonlyMap<string, PhotoRef> = new Map();

/** The signed-in person's own photo state in this workspace. */
export function useMyPhoto(organizationSlug: string) {
  const queryClient = useContext(QueryClientContext);
  return useQuery(
    {
      queryKey: myPhotoKey(organizationSlug),
      queryFn: () => fetchMyPhoto(browserApiClient(), organizationSlug),
      staleTime: FIVE_MINUTES,
      retry: false,
      enabled: queryClient !== undefined && organizationSlug !== '',
    },
    queryClient ?? IDLE_QUERY_CLIENT,
  );
}

/** 256 px for the large orbs, 64 px for every small one. */
function sizeFor(size: AvatarProps['size']): PhotoSize {
  return size === 'feature' || size === 'hero' ? 256 : 64;
}

export interface PersonAvatarProps extends Omit<AvatarProps, 'src'> {
  /** The workspace; omitted, it is the page's `[orgSlug]` (the review viewer knows no slug). */
  organizationSlug?: string;
  /** The person's user id (or, where a screen only has it, `membershipId`); else the initials. */
  userId?: string | null | undefined;
  membershipId?: string | null | undefined;
  /**
   * What a screen with its own approved initials mark (the People screens' `ppl-avatar`) draws when
   * the person has no photo. The photo decision still lives here; only the no-photo look differs.
   */
  fallback?: ReactNode;
}

export function PersonAvatar({ organizationSlug, ...props }: PersonAvatarProps) {
  return organizationSlug === undefined ? (
    <RoutedPersonAvatar {...props} />
  ) : (
    <SlugPersonAvatar {...props} slug={organizationSlug} />
  );
}

/** Reads the slug from the route only when the screen did not pass one. */
function RoutedPersonAvatar(props: Omit<PersonAvatarProps, 'organizationSlug'>) {
  const params = useParams<{ orgSlug?: string }>();
  return <SlugPersonAvatar {...props} slug={params?.orgSlug ?? ''} />;
}

function SlugPersonAvatar({
  slug,
  userId,
  membershipId,
  fallback,
  ...avatar
}: Omit<PersonAvatarProps, 'organizationSlug'> & { slug: string }) {
  const photos = usePeoplePhotos(slug);
  const ref =
    (userId ? photos.get(userId) : undefined) ??
    (membershipId ? photos.get(membershipId) : undefined);
  const src = ref
    ? personPhotoUrl(apiBaseUrl(), slug, ref.userId, ref.version, sizeFor(avatar.size))
    : undefined;
  if (!src && fallback !== undefined) return <>{fallback}</>;
  return <Avatar {...avatar} {...(src ? { src } : {})} />;
}

/** The signed-in person's own avatar (the rail account button, the Profile page). */
export function MyAvatar({
  organizationSlug,
  ...avatar
}: Omit<AvatarProps, 'src'> & { organizationSlug: string }) {
  const mine = useMyPhoto(organizationSlug);
  const photo = mine.data?.removedHere === false ? mine.data.photo : null;
  const src = photo
    ? myPhotoUrl(apiBaseUrl(), organizationSlug, photo.version, sizeFor(avatar.size))
    : undefined;
  return <Avatar {...avatar} {...(src ? { src } : {})} />;
}
