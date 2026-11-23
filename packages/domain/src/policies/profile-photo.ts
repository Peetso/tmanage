import type { Principal } from './authorize.js';
import { isClientRole } from './capabilities.js';

/**
 * Profile photo (owner, 2026-11-23) — whose photo a signed-in person may see in one company. The one
 * place this is decided (AR-8); the photo list and the image route both ask it.
 *
 * - The subject must belong to the company: an active member, or an active client contact of it.
 *   A photo is never a way to learn about someone outside the company.
 * - An internal member sees every member's and every client contact's photo (they already see
 *   these people by name across the company's work).
 * - A client contact sees the company's members (the studio people they work with) and the
 *   contacts of their OWN client organization, never another client's contacts — the rule that
 *   two client principals in one tenant never see each other's objects (`Principal`).
 * - A photo an owner or admin removed in this company is hidden here while it is the same photo
 *   (the removal names the photo's digest); a new upload shows again.
 */
export interface PhotoSubject {
  /** An active internal membership in this company. */
  readonly internalMember: boolean;
  /** The client organizations of this company the subject is an active contact of. */
  readonly clientOrganizationIds: readonly string[];
}

export type PhotoViewer = Pick<Principal, 'kind' | 'role' | 'clientOrganizationId'>;

function isClientViewer(viewer: PhotoViewer): boolean {
  return viewer.kind === 'client' || isClientRole(viewer.role);
}

export function maySeeProfilePhoto(viewer: PhotoViewer, subject: PhotoSubject): boolean {
  if (subject.internalMember) return true;
  if (subject.clientOrganizationIds.length === 0) return false;
  if (!isClientViewer(viewer)) return true;
  const own = viewer.clientOrganizationId;
  return own !== null && subject.clientOrganizationIds.includes(own);
}

/**
 * Whether a person appears in the company's photo LIST for this viewer. A client contact is never
 * handed the company's staff roster this way (the client projection names no staff, 12-PERMISSION-
 * MATRIX §4): the list gives a client only their own client organization's contacts. A staff photo
 * a client already knows the person of (by id, from a thread they see) is still served by the
 * image route under {@link maySeeProfilePhoto}.
 */
export function mayListProfilePhoto(viewer: PhotoViewer, subject: PhotoSubject): boolean {
  if (!maySeeProfilePhoto(viewer, subject)) return false;
  return !isClientViewer(viewer) || !subject.internalMember;
}

/** True when this company removed exactly this photo (same digest). */
export function isPhotoRemovedHere(photoSha256: string, removedSha256: string | null): boolean {
  return removedSha256 !== null && removedSha256 === photoSha256;
}
