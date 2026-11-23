import { Readable } from 'node:stream';
import {
  authorize,
  isPhotoRemovedHere,
  mayListProfilePhoto,
  maySeeProfilePhoto,
} from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import { judgePhoto, photoVersion, renderPhoto } from './profile-photo-image.js';
import type { PhotoSize } from './profile-photo-image.js';
import type { PhotoCandidateRow, ProfilePhotoRepository } from './profile-photo.repository.js';

/**
 * Profile photo (owner, 2026-11-23: "why can't I change my profile picture?").
 *
 * - Own photo (`…/me/photo`): only the signed-in person changes it. The user id is the principal's;
 *   nothing in the request names a person. Set/replace and remove are audited
 *   (`member.photo_changed`) in the same transaction (DA-11).
 * - Upload: the bytes are judged (JPEG, PNG, WebP by signature; header size), scanned when a malware
 *   engine is configured (an infected file is refused; an engine that cannot be reached refuses the
 *   upload rather than storing it unchecked), then re-encoded from pixels into two WebP squares.
 *   What was sent is never stored (`profile-photo-image.ts`).
 * - Seeing photos (`…/people-photos`): {@link maySeeProfilePhoto} decides (one place, AR-8), and the
 *   list also applies {@link mayListProfilePhoto} (a client is never handed the staff roster); a person
 *   outside the company, another client's contact, or a photo removed here is not found (404, the
 *   same answer as "no photo", so nothing is learned).
 * - Removal by an owner or admin (`DELETE …/people-photos/:userId`, `org.manage`): hides that exact
 *   photo in this company only, audited (`member.photo_removed`). It never touches the person's
 *   photo in another company (the x216 rule).
 */

export interface MyPhotoView {
  /** The own photo, or null for initials. `version` is the image URL's cache key. */
  readonly photo: { readonly version: string; readonly updatedAt: string } | null;
  /** This company's owner or admin removed this exact photo here; other companies still show it. */
  readonly removedHere: boolean;
}

export interface PersonPhotoView {
  readonly userId: string;
  /** The person's membership ids here (internal and client contact), for screens keyed by them. */
  readonly membershipIds: readonly string[];
  readonly version: string;
}

/** `GET …/people-photos`: everyone in this company whose photo the caller may see. */
export interface PeoplePhotosView {
  readonly photos: readonly PersonPhotoView[];
}

export interface PhotoImage {
  readonly bytes: Buffer;
  readonly version: string;
}

export interface PhotoUploadInput {
  readonly mimeType: string;
  readonly bytes: Buffer;
}

const NOW = (): Date => new Date();

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function refused(message: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field: 'dataBase64', message }]);
}

export class ProfilePhotoService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly photos: ProfilePhotoRepository,
    private readonly audit: AuditService,
    private readonly scanner?: MalwareScanner,
    private readonly now: () => Date = NOW,
  ) {}

  async getMine(context: TenantContext, principal: Principal): Promise<MyPhotoView> {
    return this.database.read(context, async (db) => {
      const own = await this.photos.findOwn(db, principal.userId);
      const removed = own ? await this.photos.findRemoval(db, context, principal.userId) : null;
      return toMyView(own, removed);
    });
  }

  async setMine(
    context: TenantContext,
    principal: Principal,
    input: PhotoUploadInput,
  ): Promise<MyPhotoView> {
    const judged = judgePhoto(input.mimeType, input.bytes);
    if (!judged.ok) throw refused(judged.message);
    await this.scan(input.bytes);
    const rendered = await renderPhoto(input.bytes, judged);
    if (!rendered.ok) throw refused(rendered.message);
    const at = this.now();
    return this.database.transaction(context, async (tx) => {
      await this.photos.upsert(
        tx,
        principal.userId,
        {
          sha256: rendered.sha256,
          image256Base64: Buffer.from(rendered.images[256]).toString('base64'),
          image64Base64: Buffer.from(rendered.images[64]).toString('base64'),
        },
        at,
      );
      await this.audit.record(tx, context, {
        action: 'member.photo_changed',
        objectId: principal.membershipId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { change: 'set' },
      });
      const removed = await this.photos.findRemoval(tx, context, principal.userId);
      return toMyView({ sha256: rendered.sha256, updatedAt: at }, removed);
    });
  }

  async removeMine(context: TenantContext, principal: Principal): Promise<MyPhotoView> {
    await this.database.transaction(context, async (tx) => {
      const own = await this.photos.findOwn(tx, principal.userId);
      if (!own) return;
      await this.photos.remove(tx, principal.userId);
      await this.audit.record(tx, context, {
        action: 'member.photo_changed',
        objectId: principal.membershipId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { change: 'removed' },
      });
    });
    return { photo: null, removedHere: false };
  }

  /** The caller's own image (also when this company removed it: the Profile page shows why). */
  async myImage(
    context: TenantContext,
    principal: Principal,
    size: PhotoSize,
  ): Promise<PhotoImage> {
    const row = await this.database.read(context, (db) =>
      this.photos.findImage(db, principal.userId, size),
    );
    if (!row) throw notFound();
    return { bytes: Buffer.from(row.imageBase64, 'base64'), version: photoVersion(row.sha256) };
  }

  async listPeople(context: TenantContext, principal: Principal): Promise<PeoplePhotosView> {
    return this.database.read(context, async (db) => {
      const [candidates, removals] = await Promise.all([
        this.photos.listCandidates(db, context),
        this.photos.listRemovals(db, context),
      ]);
      const photos = candidates
        .filter(
          (row) =>
            mayListProfilePhoto(principal, row) &&
            visible(principal, row, removals.get(row.userId) ?? null),
        )
        .map((row) => ({
          userId: row.userId,
          membershipIds: [...row.membershipIds].sort(),
          version: photoVersion(row.sha256),
        }))
        .sort((a, b) => a.userId.localeCompare(b.userId));
      return { photos };
    });
  }

  async personImage(
    context: TenantContext,
    principal: Principal,
    userId: string,
    size: PhotoSize,
  ): Promise<PhotoImage> {
    return this.database.read(context, async (db) => {
      const [candidate] = await this.photos.listCandidates(db, context, userId);
      const removed = candidate ? await this.photos.findRemoval(db, context, userId) : null;
      if (!candidate || !visible(principal, candidate, removed)) throw notFound();
      const row = await this.photos.findImage(db, userId, size);
      if (!row) throw notFound();
      return { bytes: Buffer.from(row.imageBase64, 'base64'), version: photoVersion(row.sha256) };
    });
  }

  /** An owner or admin hides a member's current photo in this company. 404 when there is none. */
  async removeMember(context: TenantContext, principal: Principal, userId: string): Promise<void> {
    requireOrgManage(principal, context);
    const at = this.now();
    await this.database.transaction(context, async (tx) => {
      const [candidate] = await this.photos.listCandidates(tx, context, userId);
      if (!candidate) throw notFound();
      const removed = await this.photos.findRemoval(tx, context, userId);
      if (isPhotoRemovedHere(candidate.sha256, removed)) return;
      await this.photos.upsertRemoval(tx, context, userId, candidate.sha256, at);
      await this.audit.record(tx, context, {
        action: 'member.photo_removed',
        objectId: userId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { client_contact: !candidate.internalMember },
      });
    });
  }

  /** Scan when an engine is configured; `none` has nothing to ask (the re-encode still applies). */
  private async scan(bytes: Buffer): Promise<void> {
    if (!this.scanner || this.scanner.kind === 'none') return;
    let verdict: 'clean' | 'infected';
    try {
      const result = await this.scanner.scan({
        stream: Readable.from([bytes]),
        sizeBytes: bytes.length,
      });
      verdict = result.verdict;
    } catch (error) {
      const message =
        error instanceof ScannerUnavailableError
          ? 'Photos cannot be checked right now. Try again in a few minutes.'
          : 'This photo could not be checked. Try another photo.';
      // HT-1: the engine is down, not the request wrong; the web says "try again".
      throw new ApiError(503, 'internal_error', message, undefined, 'photo_scanner_unavailable');
    }
    if (verdict === 'infected') {
      throw new ApiError(
        422,
        'file_not_allowed',
        'This photo cannot be used. Choose another photo.',
        [{ field: 'dataBase64', message: 'malware_detected' }],
      );
    }
  }
}

function toMyView(
  own: { sha256: string; updatedAt: Date } | null,
  removed: string | null,
): MyPhotoView {
  if (!own) return { photo: null, removedHere: false };
  return {
    photo: { version: photoVersion(own.sha256), updatedAt: own.updatedAt.toISOString() },
    removedHere: isPhotoRemovedHere(own.sha256, removed),
  };
}

function visible(principal: Principal, row: PhotoCandidateRow, removed: string | null): boolean {
  return maySeeProfilePhoto(principal, row) && !isPhotoRemovedHere(row.sha256, removed);
}

/** The tenant-checked `org.manage` decision, after the guard — the rule a unit test proves. */
function requireOrgManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      `people.photo:${verdict.code}`,
    );
  }
}
