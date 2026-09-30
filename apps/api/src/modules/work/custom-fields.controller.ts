import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_CUSTOM_FIELDS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  WorkCustomFieldDefinitionView,
  WorkCustomFieldValueView,
  WorkCustomFieldsService,
} from './custom-fields.service.js';

/**
 * x306's HTTP surface — org-defined custom fields on work items (Work module).
 *
 * Two shapes of resource on one controller. Field *definitions* are org metadata
 * (`…/work/custom-fields`) behind `org.manage` — the coarse route gate; the service authorizes
 * `org.manage` again before it writes. A field *value* is a sub-resource of a work item
 * (`…/work-items/:workItemId/custom-fields`), the way the labels are — the parent id is in the path,
 * the service resolves it tenant-scoped before it authorizes (`work.read` to read, `work.update` to
 * set) or writes.
 */

interface DefineFieldBody {
  readonly key?: unknown;
  readonly name?: unknown;
  readonly fieldType?: unknown;
  readonly options?: unknown;
}

interface SetValueBody {
  readonly value?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkCustomFieldsController {
  constructor(
    @Inject(WORK_CUSTOM_FIELDS_SERVICE) private readonly fields: WorkCustomFieldsService,
  ) {}

  @Get('work/custom-fields')
  @RequireCapability('org.manage')
  async listDefinitions(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly fields: readonly WorkCustomFieldDefinitionView[] }> {
    return { fields: await this.fields.listDefinitions(context, principal) };
  }

  @Post('work/custom-fields')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: DefineFieldBody,
  ): Promise<WorkCustomFieldDefinitionView> {
    return this.fields.define(context, principal, {
      key: body?.key as string,
      name: body?.name as string,
      fieldType: body?.fieldType as string,
      options: (body?.options as readonly string[] | null | undefined) ?? null,
    });
  }

  @Delete('work/custom-fields/:key')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
  ): Promise<void> {
    await this.fields.remove(context, principal, key);
  }

  @Get('work-items/:workItemId/custom-fields')
  @RequireCapability('work.read')
  async listForItem(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly fields: readonly WorkCustomFieldValueView[] }> {
    return { fields: await this.fields.listForItem(context, principal, workItemId) };
  }

  @Put('work-items/:workItemId/custom-fields/:key')
  @RequireCapability('work.update')
  async setValue(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('key') key: string,
    @Body() body: SetValueBody,
  ): Promise<WorkCustomFieldValueView> {
    return this.fields.setValue(context, principal, workItemId, key, body?.value);
  }
}
