import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../../platform-admin/require-platform-permission.decorator.js';
import type { AllowlistEntry, BlockEntry } from './network-access.repository.js';
import { NETWORK_ACCESS_SERVICE } from './network-access.service.js';
import type { NetworkAccessService, NetworkAccessView } from './network-access.service.js';

/**
 * SEC-ALERTS item 7 — the platform admin's view of the sign-in door:
 *
 * - `GET  /v1/platform/security/network-access` — the policy (`refuse` | `allow`) and the allowlist;
 * - `PUT  /v1/platform/security/network-access/policy` `{ mode }`;
 * - `POST /v1/platform/security/network-access/allowlist` `{ value, note? }` — an address, a CIDR
 *   (at most a /8) or `AS<number>`;
 * - `DELETE /v1/platform/security/network-access/allowlist/:id`;
 * - SEC-TRACKER (0406): `POST …/network-access/blocklist` `{ value, note? }` — an address or a CIDR
 *   of at most /24 (IPv4) or /48 (IPv6); 409 when it holds the caller's own address, overlaps an
 *   allowlist entry or an existing block. Refused at the sign-in door first, whatever the policy;
 * - `DELETE …/network-access/blocklist/:id`.
 *
 * The GET also returns `blocked[]` (the block list) and `lists[]` (each free list's size and last
 * sweep; never the stored error text).
 *
 * Platform admins with `platform.settings.edit`, behind a fresh step-up (the guard); every write
 * lands with its platform audit row in one transaction.
 */
@Controller('v1/platform/security/network-access')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformNetworkAccessController {
  constructor(@Inject(NETWORK_ACCESS_SERVICE) private readonly service: NetworkAccessService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  view(): Promise<NetworkAccessView> {
    return this.service.view();
  }

  @Put('policy')
  @RequirePlatformPermission('platform.settings.edit')
  setPolicy(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<NetworkAccessView> {
    return this.service.setPolicy(actor, body ?? {}, platformRequestContext(request));
  }

  @Post('allowlist')
  @RequirePlatformPermission('platform.settings.edit')
  add(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<AllowlistEntry> {
    return this.service.addEntry(actor, body ?? {}, platformRequestContext(request));
  }

  @Delete('allowlist/:id')
  @HttpCode(204)
  @RequirePlatformPermission('platform.settings.edit')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Req() request: object,
  ): Promise<void> {
    return this.service.removeEntry(actor, id, platformRequestContext(request));
  }

  @Post('blocklist')
  @RequirePlatformPermission('platform.settings.edit')
  block(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<BlockEntry> {
    return this.service.addBlock(actor, body ?? {}, platformRequestContext(request));
  }

  @Delete('blocklist/:id')
  @HttpCode(204)
  @RequirePlatformPermission('platform.settings.edit')
  unblock(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Req() request: object,
  ): Promise<void> {
    return this.service.removeBlock(actor, id, platformRequestContext(request));
  }
}
