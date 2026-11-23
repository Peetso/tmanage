import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HeaderWriter } from '../files/download-response.js';
import { decodeLogoBase64 } from '../tenancy/organization-logo-image.js';
import { PHOTO_UPLOAD_MAX_BYTES } from './profile-photo-image.js';
import type { PhotoSize } from './profile-photo-image.js';
import type { ProfilePhotoService } from './profile-photo.service.js';
import type {
  MyPhotoView,
  PeoplePhotosView,
  PhotoImage,
  PhotoUploadInput,
} from './profile-photo.service.js';

/**
 * Profile photo routes (owner, 2026-11-23). All under the company, all behind `work.read` except the
 * admin removal (`org.manage`, re-checked in the service):
 *
 * - `GET/PUT/DELETE …/me/photo` — the caller's own photo state, upload (`{ mimeType, dataBase64 }`,
 *   at most 512 KiB decoded) and removal. No person id anywhere: the subject is the principal.
 * - `GET …/me/photo/image?size=64|256` — the caller's own image.
 * - `GET …/people-photos` — `{ photos: [{ userId, version }] }` for everyone here the caller may see.
 * - `GET …/people-photos/:userId?size=64|256&v=` — one person's image. `v` equal to the current
 *   version makes the answer cacheable for a year (the URL changes with the photo).
 * - `DELETE …/people-photos/:userId` — an owner or admin removes that photo in this company.
 *
 * Images are served as `image/webp` with `nosniff` and a sandboxing CSP, like the company logo.
 */
export const PROFILE_PHOTO_SERVICE = Symbol.for('tmanage.ProfilePhotoService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

/** `{ mimeType, dataBase64 }`. Shape errors are 400s before any decoding work. */
export function parsePhotoUpload(body: unknown): PhotoUploadInput {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const mimeType = typeof input['mimeType'] === 'string' ? input['mimeType'].trim() : '';
  if (mimeType === '' || mimeType.length > 150) {
    throw invalid('mimeType', 'must be image/jpeg, image/png or image/webp');
  }
  const raw = input['dataBase64'];
  // Base64 is 4/3 of the bytes; anything longer than the cap's encoding is refused unread.
  if (typeof raw !== 'string' || raw.length > Math.ceil(PHOTO_UPLOAD_MAX_BYTES / 3) * 4 + 1024) {
    throw invalid('dataBase64', 'The photo is too large. Choose a smaller photo and try again.');
  }
  const bytes = decodeLogoBase64(raw);
  if (!bytes) throw invalid('dataBase64', 'must be base64');
  return { mimeType, bytes };
}

export function parsePhotoSize(raw: unknown): PhotoSize {
  if (raw === undefined || raw === '' || raw === '64') return 64;
  if (raw === '256') return 256;
  throw invalid('size', 'must be 64 or 256');
}

function parseUserId(raw: string): string {
  if (!UUID.test(raw)) throw new ApiError(404, 'not_found', 'Not found');
  return raw;
}

function send(reply: HeaderWriter, image: PhotoImage, requested: unknown): StreamableFile {
  reply.header('content-type', 'image/webp');
  reply.header('content-length', String(image.bytes.length));
  reply.header('content-disposition', 'inline; filename="photo.webp"');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header(
    'cache-control',
    requested === image.version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  );
  reply.header('etag', `"${image.version}"`);
  return new StreamableFile(image.bytes);
}

@Controller('v1/organizations/:orgSlug')
export class ProfilePhotoController {
  constructor(@Inject(PROFILE_PHOTO_SERVICE) private readonly photos: ProfilePhotoService) {}

  @Get('me/photo')
  @RequireCapability('work.read')
  async mine(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyPhotoView> {
    return this.photos.getMine(context, principal);
  }

  @Put('me/photo')
  @RequireCapability('work.read')
  @HttpCode(200)
  async upload(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<MyPhotoView> {
    return this.photos.setMine(context, principal, parsePhotoUpload(body));
  }

  @Delete('me/photo')
  @RequireCapability('work.read')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyPhotoView> {
    return this.photos.removeMine(context, principal);
  }

  @Get('me/photo/image')
  @RequireCapability('work.read')
  async myImage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('size') size: unknown,
    @Query('v') version: unknown,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const image = await this.photos.myImage(context, principal, parsePhotoSize(size));
    return send(reply, image, version);
  }

  @Get('people-photos')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PeoplePhotosView> {
    return this.photos.listPeople(context, principal);
  }

  @Get('people-photos/:userId')
  @RequireCapability('work.read')
  async image(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Query('size') size: unknown,
    @Query('v') version: unknown,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const image = await this.photos.personImage(
      context,
      principal,
      parseUserId(userId),
      parsePhotoSize(size),
    );
    return send(reply, image, version);
  }

  @Delete('people-photos/:userId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async removeMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.photos.removeMember(context, principal, parseUserId(userId));
  }
}
