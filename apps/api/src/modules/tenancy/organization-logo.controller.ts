import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Module,
  Optional,
  Put,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { HeaderWriter } from '../files/download-response.js';
import { acceptLogo, decodeLogoBase64, LOGO_MAX_BYTES } from './organization-logo-image.js';
import { OrganizationLogoRepository } from './organization-logo.repository.js';
import type { OrganizationLogoInfo } from './organization-logo.repository.js';

/**
 * C6 — the company logo, held by the organization (no project).
 *
 * - `GET …/logo` (any member, `work.read`): whether a logo is set, its type and its version.
 * - `GET …/logo/image` (any member, `work.read`): the image itself.
 * - `PUT …/logo/image` (`org.manage`): upload a PNG, JPEG, WebP or SVG as base64. Raster images
 *   must carry their signature; SVG is stored only as the server-side sanitiser rebuilt it
 *   (`svg-sanitizer.ts`). A file that cannot be accepted is a 400 whose message the card shows.
 * - `DELETE …/logo/image` (`org.manage`): back to the initials. Clears an old-style file logo too.
 *
 * The image is served with `nosniff`, `attachment` and a sandboxing CSP, so even opened directly an
 * SVG logo runs nothing.
 */

export interface OrganizationLogoView {
  readonly logo: {
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly version: number;
    readonly updatedAt: string;
  } | null;
}

function toView(info: OrganizationLogoInfo | null): OrganizationLogoView {
  return {
    logo: info
      ? {
          mimeType: info.mimeType,
          sizeBytes: info.sizeBytes,
          version: info.version,
          updatedAt: info.updatedAt.toISOString(),
        }
      : null,
  };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

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
      `organization.logo:${verdict.code}`,
    );
  }
}

/** Parse `{ mimeType, dataBase64 }`. Shape errors are 400s before any decoding work. */
export function parseLogoUpload(body: unknown): { mimeType: string; bytes: Buffer } {
  const input = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const mimeType = typeof input['mimeType'] === 'string' ? input['mimeType'].trim() : '';
  if (mimeType === '' || mimeType.length > 150) {
    details.push({ field: 'mimeType', message: 'must be a media type such as image/png' });
  }
  const raw = input['dataBase64'];
  let bytes: Buffer | null = null;
  // Base64 is 4/3 of the bytes; anything longer than the cap's encoding is refused unread.
  if (typeof raw !== 'string' || raw.length > Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 1024) {
    details.push({
      field: 'dataBase64',
      message: 'The logo is larger than 512 KB. Save a smaller file and try again.',
    });
  } else {
    bytes = decodeLogoBase64(raw);
    if (!bytes) details.push({ field: 'dataBase64', message: 'must be base64' });
  }
  if (details.length > 0 || !bytes) {
    throw new ApiError(400, 'validation_failed', 'That file cannot be used as the logo.', details);
  }
  return { mimeType, bytes };
}

const ORGANIZATION_LOGO_REPOSITORY = Symbol.for('tmanage.OrganizationLogoRepository');

@Controller('v1/organizations')
export class OrganizationLogoController {
  private readonly audit: AuditService | undefined;

  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(ORGANIZATION_LOGO_REPOSITORY) private readonly logos: OrganizationLogoRepository,
    @Optional() @Inject(AUDIT_SERVICE) audit?: AuditService,
  ) {
    this.audit = audit;
  }

  @Get(':orgSlug/logo')
  @RequireCapability('work.read')
  async info(@Ctx() context: TenantContext): Promise<OrganizationLogoView> {
    const info = await this.database.read(context, (db) => this.logos.findInfo(db, context));
    return toView(info);
  }

  @Get(':orgSlug/logo/image')
  @RequireCapability('work.read')
  async image(
    @Ctx() context: TenantContext,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const image = await this.database.read(context, (db) => this.logos.findImage(db, context));
    if (!image) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const bytes = Buffer.from(image.contentBase64, 'base64');
    reply.header('content-type', image.mimeType);
    reply.header('content-length', String(bytes.length));
    reply.header(
      'content-disposition',
      `attachment; filename="logo.${EXTENSIONS[image.mimeType] ?? 'img'}"`,
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    reply.header('cache-control', 'private, max-age=300');
    reply.header('etag', `"${image.sha256}"`);
    return new StreamableFile(bytes);
  }

  @Put(':orgSlug/logo/image')
  @RequireCapability('org.manage')
  async upload(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<OrganizationLogoView> {
    requireOrgManage(principal, context);
    const { mimeType, bytes } = parseLogoUpload(body);
    const accepted = acceptLogo(mimeType, bytes);
    if (!accepted.ok) {
      throw new ApiError(400, 'validation_failed', accepted.message, [
        { field: 'dataBase64', message: accepted.message },
      ]);
    }
    const info = await this.database.transaction(context, async (tx) => {
      await this.logos.upsert(tx, context, {
        mimeType: accepted.mimeType,
        sizeBytes: accepted.bytes.length,
        sha256: accepted.sha256,
        contentBase64: accepted.bytes.toString('base64'),
      });
      await this.audit?.record(tx, context, {
        action: 'organization.logo_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { change: 'set', sanitized: accepted.removed.length > 0 },
      });
      return this.logos.findInfo(tx, context);
    });
    return toView(info);
  }

  @Delete(':orgSlug/logo/image')
  @RequireCapability('org.manage')
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrganizationLogoView> {
    requireOrgManage(principal, context);
    await this.database.transaction(context, async (tx) => {
      await this.logos.remove(tx, context);
      await this.audit?.record(tx, context, {
        action: 'organization.logo_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { change: 'removed' },
      });
    });
    return { logo: null };
  }
}

/** Registered in `app.module.ts` directly (one line), so no shared module file is touched. */
@Module({})
export class OrganizationLogoModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: ORGANIZATION_LOGO_REPOSITORY,
      useFactory: () => new OrganizationLogoRepository(),
    };
    return {
      module: OrganizationLogoModule,
      providers: [repository],
      controllers: [OrganizationLogoController],
    };
  }
}
