import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  DuplicateProjectTemplateNameError,
  ProjectTemplatesRepository,
} from './templates.repository.js';
import { TemplatePacksRepository } from './template-packs.repository.js';
import {
  findTemplatePack,
  packTemplateDescription,
  templatePacksForRole,
} from './template-packs.catalog.js';
import type { PackRole, PackWorkWeek, TemplatePack } from './template-packs.catalog.js';

/** 54-22. The DI token of {@link TemplatePacksService}. */
export const TEMPLATE_PACKS_SERVICE = Symbol.for('tmanage.TemplatePacksService');

/** What the gallery shows of one pack. */
export interface TemplatePackView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** 55-02. The roles the pack is meant for. */
  readonly roles: readonly PackRole[];
  /** 54-23. `ar` for an Arabic pack. */
  readonly language: 'en' | 'ar';
  /** 54-23. The working week the pack's dates assume. */
  readonly workWeek: PackWorkWeek;
  readonly templateNames: readonly string[];
  readonly docs: readonly string[];
  readonly automations: readonly string[];
  readonly installed: boolean;
  /** An ISO-8601 instant; null while the pack is not installed. */
  readonly installedAt: string | null;
}

export interface TemplatePackInstallResult {
  readonly pack: TemplatePackView;
  /** Templates the install added. */
  readonly templatesCreated: number;
  /** Templates skipped because a template with that name already existed. */
  readonly templatesSkipped: number;
}

function toView(pack: TemplatePack, installedAt: Date | null): TemplatePackView {
  return {
    key: pack.key,
    name: pack.name,
    description: pack.description,
    roles: pack.roles,
    language: pack.language,
    workWeek: pack.workWeek,
    templateNames: pack.templates.map((template) => template.name),
    docs: pack.docs,
    automations: pack.automations,
    installed: installedAt !== null,
    installedAt: installedAt?.toISOString() ?? null,
  };
}

/**
 * 54-22. The template-packs gallery: list the built-in packs with this workspace's install state,
 * and install a pack, which creates its project templates.
 *
 * Both are gated on `project.manage`, the capability that manages templates, re-checked here at
 * the org level with the real evaluator (the route guard asks the same question first). Install
 * runs in one transaction: a template whose name is already used is skipped (never overwritten),
 * and the install row is written last, so a failed install leaves no half-installed pack.
 */
export class TemplatePacksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly packs: TemplatePacksRepository = new TemplatePacksRepository(),
    private readonly templates: ProjectTemplatesRepository = new ProjectTemplatesRepository(),
  ) {}

  private requireManage(context: TenantContext, principal: Principal): void {
    const { allowed } = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_project.manage');
    }
  }

  /** The gallery; `role` (55-02) narrows it to the packs meant for that role. */
  async list(
    context: TenantContext,
    principal: Principal,
    role: PackRole | null = null,
  ): Promise<readonly TemplatePackView[]> {
    this.requireManage(context, principal);
    const installed = await this.database.read(context, (runner) =>
      this.packs.listInstalled(runner, context),
    );
    const byKey = new Map(installed.map((row) => [row.packKey, row.installedAt]));
    return templatePacksForRole(role).map((pack) => toView(pack, byKey.get(pack.key) ?? null));
  }

  async install(
    context: TenantContext,
    principal: Principal,
    packKey: string,
  ): Promise<TemplatePackInstallResult> {
    this.requireManage(context, principal);
    const pack = findTemplatePack(packKey);
    if (!pack) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_pack_unknown');
    }

    const { created, skipped } = await this.database.transaction(context, async (tx) => {
      if (await this.packs.findByKey(tx, context, pack.key)) {
        throw new ApiError(409, 'conflict', 'This pack is already installed');
      }
      let made = 0;
      let passed = 0;
      for (const template of pack.templates) {
        try {
          await this.templates.create(tx, context, {
            name: template.name,
            description: packTemplateDescription(pack, template),
            ...(template.defaultObjectives
              ? { defaultObjectives: template.defaultObjectives }
              : {}),
            ...(template.milestones ? { milestones: template.milestones } : {}),
            ...(template.workItems ? { workItems: template.workItems } : {}),
            clientPortalOn: template.clientPortalOn ?? false,
            repeatInterval: template.repeatInterval ?? null,
            createdBy: context.userId,
          });
          made += 1;
        } catch (error) {
          if (!(error instanceof DuplicateProjectTemplateNameError)) throw error;
          passed += 1;
        }
      }
      await this.packs.recordInstall(tx, context, { packKey: pack.key, templatesCreated: made });
      return { created: made, skipped: passed };
    });

    return {
      pack: toView(pack, new Date()),
      templatesCreated: created,
      templatesSkipped: skipped,
    };
  }
}
