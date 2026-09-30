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
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MeetingAgendaTemplateItem } from '../../common/database/schema.js';
import { AGENDA_TEMPLATES_SERVICE } from './agenda-templates.service.js';
import type {
  AgendaTemplateView,
  ApplyAgendaTemplateResult,
  AgendaTemplatesService,
} from './agenda-templates.service.js';

/**
 * CAL agenda templates (x314). A member defines reusable meeting agenda templates — a name and an
 * ordered list of items — and applies one to a meeting to seed its agenda items idempotently.
 * Complements the per-meeting agenda (x127) with reuse.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header
 * or its `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The template CRUD is org-scoped (behind `meeting.read`/`meeting.write`); the apply
 * route names a meeting by path id, which the service resolves tenant-scoped **before** the relation
 * check and any write (the Known-trap order), so a cross-tenant `meetingId` is a 404 with no write.
 *
 * `agenda-templates` is a literal segment and `apply-agenda-template` is nested under `:meetingId`,
 * so the two never collide with each other or with the sibling meeting routes.
 */

const MAX_ITEMS = 100;
const MAX_TITLE_LENGTH = 300;
const MAX_NAME_LENGTH = 300;

interface AgendaTemplateBody {
  readonly name?: unknown;
  readonly items?: unknown;
}

interface ApplyTemplateBody {
  readonly templateId?: unknown;
}

@Controller('v1/organizations/:orgSlug/meetings')
export class AgendaTemplatesController {
  constructor(
    @Inject(AGENDA_TEMPLATES_SERVICE) private readonly templates: AgendaTemplatesService,
  ) {}

  @Post('agenda-templates')
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: AgendaTemplateBody,
  ): Promise<AgendaTemplateView> {
    const { name, items } = parseTemplateBody(body);
    return this.templates.create(context, principal, { name, items });
  }

  @Get('agenda-templates')
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly templates: readonly AgendaTemplateView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }
    return {
      templates: await this.templates.list(context, principal, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Put('agenda-templates/:templateId')
  @RequireCapability('meeting.write')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: AgendaTemplateBody,
  ): Promise<AgendaTemplateView> {
    if (typeof templateId !== 'string' || templateId === '') {
      throw new ApiError(400, 'validation_failed', 'templateId is required', [
        { field: 'templateId', message: 'must be a non-empty string' },
      ]);
    }
    const { name, items } = parseTemplateBody(body);
    return this.templates.update(context, principal, templateId, { name, items });
  }

  @Delete('agenda-templates/:templateId')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<void> {
    if (typeof templateId !== 'string' || templateId === '') {
      throw new ApiError(400, 'validation_failed', 'templateId is required', [
        { field: 'templateId', message: 'must be a non-empty string' },
      ]);
    }
    await this.templates.delete(context, principal, templateId);
  }

  @Post(':meetingId/apply-agenda-template')
  @RequireCapability('meeting.write')
  async apply(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: ApplyTemplateBody,
  ): Promise<ApplyAgendaTemplateResult> {
    const templateId = typeof body?.templateId === 'string' ? body.templateId : undefined;
    const details = [
      ...(meetingId ? [] : [{ field: 'meetingId', message: 'must be a non-empty string' }]),
      ...(templateId ? [] : [{ field: 'templateId', message: 'must be a non-empty string' }]),
    ];
    if (details.length > 0 || !meetingId || !templateId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.templates.applyToMeeting(context, principal, meetingId, templateId);
  }
}

/**
 * Validate a template create/update body: a non-empty `name` and a non-empty, well-formed ordered
 * `items` list. Each item needs a non-empty `title`; `position` is assigned from the item's index so
 * the stored order is the submitted order regardless of any client-supplied positions. An empty name
 * or empty items list is a 400 with no write — the brief's rule.
 */
function parseTemplateBody(body: AgendaTemplateBody): {
  name: string;
  items: readonly MeetingAgendaTemplateItem[];
} {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    details.push({ field: 'name', message: 'must be a non-empty string' });
  } else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be at most ${MAX_NAME_LENGTH} characters` });
  }

  const rawItems = Array.isArray(body?.items) ? body.items : undefined;
  const items: MeetingAgendaTemplateItem[] = [];
  if (!rawItems || rawItems.length === 0) {
    details.push({ field: 'items', message: 'must be a non-empty array of agenda items' });
  } else if (rawItems.length > MAX_ITEMS) {
    details.push({ field: 'items', message: `must have at most ${MAX_ITEMS} items` });
  } else {
    rawItems.forEach((raw, index) => {
      const title =
        typeof (raw as { title?: unknown } | null)?.title === 'string'
          ? (raw as { title: string }).title.trim()
          : '';
      if (title === '') {
        details.push({ field: `items[${index}].title`, message: 'must be a non-empty string' });
      } else if (title.length > MAX_TITLE_LENGTH) {
        details.push({
          field: `items[${index}].title`,
          message: `must be at most ${MAX_TITLE_LENGTH} characters`,
        });
      } else {
        items.push({ title, position: index });
      }
    });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return { name, items };
}
