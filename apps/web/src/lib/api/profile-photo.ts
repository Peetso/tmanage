import type { ApiClient } from './client';

/**
 * Profile photo (owner, 2026-11-23). The API checks every upload (JPEG, PNG or WebP by its bytes,
 * a virus scan when one is set up) and stores only new 256 and 64 px squares it makes itself, so no
 * EXIF or location data is kept. Paired with the API's `MyPhotoView` / `PeoplePhotosView`.
 */
export interface MyPhotoView {
  readonly photo: { readonly version: string; readonly updatedAt: string } | null;
  /** An owner or admin of this workspace removed this photo here. */
  readonly removedHere: boolean;
}

export interface PersonPhotoView {
  readonly userId: string;
  /** The person's membership ids in this workspace (internal and client contact). */
  readonly membershipIds: readonly string[];
  readonly version: string;
}

export interface PeoplePhotosView {
  readonly photos: readonly PersonPhotoView[];
}

export type PhotoSize = 64 | 256;

/** The types the picker offers, and the largest file a person may pick (5 MB). */
export const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
export const PHOTO_PICK_MAX_BYTES = 5 * 1024 * 1024;
/** The square the browser sends after the crop; the API makes its own 256 and 64 px copies. */
export const PHOTO_UPLOAD_SIDE = 512;

const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const BY_EXTENSION: Readonly<Record<string, (typeof TYPES)[number]>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** The photo type of a picked file, or null when it is not one the page takes. */
export function photoMimeType(file: {
  readonly name: string;
  readonly type: string;
}): string | null {
  const reported = file.type.trim().toLowerCase();
  if ((TYPES as readonly string[]).includes(reported)) return reported;
  return BY_EXTENSION[file.name.toLowerCase().split('.').pop() ?? ''] ?? null;
}

function org(slug: string): string {
  return `/v1/organizations/${encodeURIComponent(slug)}`;
}

export const myPhotoKey = (slug: string) => ['me', 'photo', slug] as const;
export const peoplePhotosKey = (slug: string) => ['people-photos', slug] as const;

export function myPhotoUrl(
  baseUrl: string,
  slug: string,
  version: string,
  size: PhotoSize,
): string {
  return `${baseUrl}${org(slug)}/me/photo/image?size=${size}&v=${encodeURIComponent(version)}`;
}

export function personPhotoUrl(
  baseUrl: string,
  slug: string,
  userId: string,
  version: string,
  size: PhotoSize,
): string {
  return `${baseUrl}${org(slug)}/people-photos/${encodeURIComponent(userId)}?size=${size}&v=${encodeURIComponent(version)}`;
}

export async function fetchMyPhoto(client: ApiClient, slug: string): Promise<MyPhotoView> {
  const { data } = await client.request<MyPhotoView>({ path: `${org(slug)}/me/photo` });
  return data;
}

export async function fetchPeoplePhotos(
  client: ApiClient,
  slug: string,
): Promise<PeoplePhotosView> {
  const { data } = await client.request<PeoplePhotosView>({ path: `${org(slug)}/people-photos` });
  return data;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Upload the cropped square (a Blob the crop made). */
export async function uploadMyPhoto(
  client: ApiClient,
  slug: string,
  image: Blob,
): Promise<MyPhotoView> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  const { data } = await client.request<MyPhotoView>({
    method: 'PUT',
    path: `${org(slug)}/me/photo`,
    body: { mimeType: image.type || 'image/jpeg', dataBase64: toBase64(bytes) },
  });
  return data;
}

export async function removeMyPhoto(client: ApiClient, slug: string): Promise<MyPhotoView> {
  const { data } = await client.request<MyPhotoView>({
    method: 'DELETE',
    path: `${org(slug)}/me/photo`,
  });
  return data;
}

/** An owner or admin removes a member's photo in this workspace only. */
export async function removeMemberPhoto(
  client: ApiClient,
  slug: string,
  userId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${org(slug)}/people-photos/${encodeURIComponent(userId)}`,
  });
}
