import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SEARCH_PINS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PinInput, SearchPinView, SearchPinsService } from './search-pins.service.js';

/**
 * SRCH quick-access pins (x290). The HTTP surface over `search_pins` — a member's own pinned
 * entities (pin/list/unpin) for quick access from the Search module.
 *
 * Every route sits behind `@RequireCapability('search.use')` — the SRCH-01 search capability,
 * **reused** so this slice stays off `capabilities.ts` and the role grid. A caller without it (a
 * client principal) is refused by the global `CapabilityGuard` with a 403 before any handler runs.
 * No route reads an `organizationId` or a `membershipId` from anywhere: the tenant and the acting
 * member are `TenantContextGuard`'s, and a pin is always the acting member's own — the object rule
 * the service and repository enforce (own-scoped list and unpin; a foreign id is invisible).
 */
@Controller('v1/organizations/:orgSlug/search')
export class SearchPinsController {
  constructor(@Inject(SEARCH_PINS_SERVICE) private readonly pins: SearchPinsService) {}

  /** The acting member's pins, newest first (200). */
  @Get('pins')
  @RequireCapability('search.use')
  async list(@Ctx() context: TenantContext): Promise<{ readonly pins: readonly SearchPinView[] }> {
    return { pins: await this.pins.list(context) };
  }

  /**
   * Pin an entity for the acting member (200 — idempotent, no resource is minted per call). A repeat
   * pin of the same target refreshes its label rather than adding a row. An `objectType` off the
   * fixed indexed-entity allowlist is a 400 with no insert.
   */
  @Put('pins')
  @RequireCapability('search.use')
  @HttpCode(200)
  async pin(@Ctx() context: TenantContext, @Body() body: PinBody): Promise<SearchPinView> {
    return this.pins.pin(context, parsePinBody(body));
  }

  /**
   * Unpin one of the acting member's pins by id (204). Own-scoped and idempotent: an id that names
   * another member's pin, another studio's pin, or nothing removes nothing and still answers 204, so
   * a pin's existence is never disclosed to anyone but its owner.
   */
  @Delete('pins/:pinId')
  @RequireCapability('search.use')
  @HttpCode(204)
  async unpin(@Ctx() context: TenantContext, @Param('pinId') pinId: string): Promise<void> {
    await this.pins.unpin(context, pinId);
  }
}

interface PinBody {
  readonly objectType?: unknown;
  readonly objectId?: unknown;
  readonly label?: unknown;
}

/** `search_pins.label` is `VARCHAR(300)`; `object_id` is a `CHAR(36)` id. */
const MAX_LABEL_LENGTH = 300;
const MAX_ID_LENGTH = 36;

/**
 * Validate the request body into a {@link PinInput}, or throw a 400 with field details. The
 * `objectType` allowlist membership is the service's to enforce (it owns the fixed set); here the
 * three fields are checked as present, well-typed, non-empty strings within their column bounds so a
 * malformed body never reaches the write.
 */
function parsePinBody(body: PinBody): PinInput {
  const details: { field: string; message: string }[] = [];

  const objectType = typeof body?.objectType === 'string' ? body.objectType.trim() : undefined;
  if (!objectType) details.push({ field: 'objectType', message: 'must be a non-empty string' });

  const objectId = typeof body?.objectId === 'string' ? body.objectId.trim() : undefined;
  if (!objectId) details.push({ field: 'objectId', message: 'must be a non-empty string' });
  else if (objectId.length > MAX_ID_LENGTH) {
    details.push({ field: 'objectId', message: `must be ${MAX_ID_LENGTH} characters or fewer` });
  }

  const label = typeof body?.label === 'string' ? body.label.trim() : undefined;
  if (!label) details.push({ field: 'label', message: 'must be a non-empty string' });
  else if (label.length > MAX_LABEL_LENGTH) {
    details.push({ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` });
  }

  if (details.length > 0 || !objectType || !objectId || !label) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  // `objectType` is carried through as-is; the service refuses one off the fixed allowlist with a
  // 400 before any write, so the cast narrows to the request shape without asserting membership.
  return { objectType: objectType as PinInput['objectType'], objectId, label };
}
