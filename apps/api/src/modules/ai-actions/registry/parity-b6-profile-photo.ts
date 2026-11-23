/**
 * AI action registry — batch 6, lane P "profile photo" (owner, 2026-11-23: "why can't I change my
 * profile picture?"; ADR-0015 part 1 rule 4: what the member can do by hand, the AI can do).
 *
 * Each op mirrors a route in `people/profile-photo.controller.ts`:
 *
 * - Reads: the member's own photo state (`me.photo.get`), their own image, the list of photos in
 *   the company and one person's image. Read-class: the routes' own visibility rule
 *   (`maySeeProfilePhoto`) decides what any caller, the AI included, may see.
 * - Upload (`me.photo.set`): the same route the Profile page uses, base64 of at most 512 KiB, the
 *   same checks (type by signature, size, malware scan, re-encode to new WebP squares). No URL is
 *   ever fetched. Confirm-class, write scope: it changes how the member is shown to everyone.
 * - Remove own (`me.photo.delete`) and remove a member's photo in this company
 *   (`people_photos.delete`, owner or admin, manage scope). Both destructive and confirm-class.
 */
import { z } from 'zod';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import { bodyArgs, det, noArgs, pathOnly, queryArgs, type AiActionDetail } from './detail.js';
import { PHOTO_TYPES, PHOTO_UPLOAD_MAX_BYTES } from '../../people/profile-photo-image.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  scope: AiScope,
): AiActionOp {
  const risk = method === 'GET' ? 'read' : 'confirm';
  return {
    id,
    method,
    path: `${ORG}${path}`,
    capability,
    risk,
    scope: risk === 'read' ? 'read' : scope,
  };
}

const R = 'read' as const;
const W = 'write' as const;
const M = 'manage' as const;

export const profilePhotoOps: readonly AiActionOp[] = [
  op('me.photo.get', 'GET', '/me/photo', 'work.read', R),
  op('me.photo.image', 'GET', '/me/photo/image', 'work.read', R),
  op('me.photo.set', 'PUT', '/me/photo', 'work.read', W),
  op('me.photo.delete', 'DELETE', '/me/photo', 'work.read', W),
  op('people_photos.list', 'GET', '/people-photos', 'work.read', R),
  op('people_photos.image', 'GET', '/people-photos/:userId', 'work.read', R),
  op('people_photos.delete', 'DELETE', '/people-photos/:userId', 'org.manage', M),
];

/** Non-read ops only. Removing a photo is destructive; setting one is an everyday change. */
export const profilePhotoSensitivity: Readonly<Record<string, Sensitivity>> = {
  'me.photo.set': 'none',
  'me.photo.delete': 'destructive',
  'people_photos.delete': 'destructive',
};

/** Standard base64 for at most {@link PHOTO_UPLOAD_MAX_BYTES} decoded bytes. */
const base64 = () =>
  z
    .string()
    .min(4)
    .max(Math.ceil(PHOTO_UPLOAD_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const size = () =>
  z.enum(['64', '256']).optional().describe('Square size in pixels: 64 (default) or 256');
const version = () =>
  z.string().max(16).optional().describe('The photo version from the list (only for caching)');
const photoTypes = PHOTO_TYPES as unknown as readonly [string, ...string[]];

export const profilePhotoDetails: readonly AiActionDetail[] = [
  det({
    id: 'me.photo.get',
    title: 'Show my profile photo state',
    description:
      'Whether the member has a profile photo (photo.version, photo.updatedAt) or shows initials ' +
      '(photo null), and removedHere: true when an owner or admin of this workspace removed this ' +
      'photo here (other workspaces still show it until the member uploads a different one).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My photo', args: {} }],
  }),
  det({
    id: 'me.photo.image',
    title: 'Get my profile photo image',
    description: 'The member’s own photo as a WebP square of 64 or 256 pixels.',
    input: queryArgs([], { size: size(), v: version() }),
    redact: 'standard',
    examples: [{ summary: 'Large', args: { size: '256' } }],
  }),
  det({
    id: 'me.photo.set',
    title: 'Set or replace my profile photo',
    description:
      'Upload the member’s own photo as standard base64 (dataBase64, at most 512 KiB decoded). ' +
      `mimeType is one of: ${PHOTO_TYPES.join(', ')}; the bytes must be that type, at least 64 ` +
      'px on the short side. The centre square is kept and re-saved as new 256 and 64 px images ' +
      '(EXIF and location data removed); it is virus-scanned first. A URL is never accepted.',
    input: bodyArgs([], { mimeType: z.enum(photoTypes), dataBase64: base64() }),
    redact: 'standard',
    examples: [{ summary: 'A JPEG', args: { mimeType: 'image/jpeg', dataBase64: '/9j/4AAQ' } }],
  }),
  det({
    id: 'me.photo.delete',
    title: 'Remove my profile photo',
    description: 'Remove the member’s own photo everywhere; their initials show instead.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: {} }],
  }),
  det({
    id: 'people_photos.list',
    title: 'List profile photos in the workspace',
    description:
      'Every person in this workspace whose photo the member may see: { photos: [{ userId, ' +
      'version }] }. Anyone not listed shows initials.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All photos', args: {} }],
  }),
  det({
    id: 'people_photos.image',
    title: 'Get a person’s profile photo image',
    description: 'One person’s photo as a WebP square of 64 or 256 pixels (not found: initials).',
    input: queryArgs(['userId'], { size: size(), v: version() }),
    redact: 'standard',
    examples: [{ summary: 'Small', args: { userId: 'u_1', size: '64' } }],
  }),
  det({
    id: 'people_photos.delete',
    title: 'Remove a member’s profile photo in this workspace',
    description:
      'Owner or admin: remove a member’s current photo in THIS workspace only (for example an ' +
      'offensive picture). Their other workspaces are not changed; a different photo they upload ' +
      'later shows again. Recorded in the audit log.',
    input: pathOnly('userId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { userId: 'u_1' } }],
  }),
];
