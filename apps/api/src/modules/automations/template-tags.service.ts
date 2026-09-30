import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { AUTOMATION_TEMPLATE_TAGS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AutomationTemplateTagRow,
  WorkflowTemplateRow,
} from '../../common/database/schema.js';
import type { AutomationTemplateTagsRepository } from './template-tags.repository.js';

/**
 * Automation template tags (module 17, x335) — the orchestration between the controller and the
 * repository. The controller owns the security ordering (resolve the template within the tenant, then
 * `org.manage`); this service owns what a *tag* is: the label is normalised and bounded here, a
 * duplicate is a 409 decided by a tenant-scoped pre-read before the insert (the unique key is the
 * authoritative backstop), a removal is idempotent, and the tag filter reads templates by label.
 *
 * Every method takes the `TenantContext` and drives the unit of work through {@link TenantDatabase}, so
 * the tenant predicate is on every statement and never comes from a request body.
 */

/** `automation_template_tags.label` is `VARCHAR(80)`. */
export const MAX_TAG_LABEL_LENGTH = 80;

@Injectable()
export class AutomationTemplateTagsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AUTOMATION_TEMPLATE_TAGS_REPOSITORY)
    private readonly tags: AutomationTemplateTagsRepository,
  ) {}

  /**
   * Normalise a raw label into the stored form, or a 400 with nothing written. The label is trimmed
   * and internal whitespace is collapsed to single spaces, so ` urgent  review ` and `urgent review`
   * are one tag; an empty (or whitespace-only) label is a 400, and one longer than the column is a 400.
   * This is the single definition of a valid label — the controller, the add path and the filter all
   * route through it.
   */
  static normalizeLabel(raw: unknown): string {
    const label = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (label === '') {
      throw new ApiError(
        400,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'label', message: 'must be a non-empty string' }],
        'automation_template_tag_label_empty',
      );
    }
    if (label.length > MAX_TAG_LABEL_LENGTH) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'label', message: `must be ${MAX_TAG_LABEL_LENGTH} characters or fewer` }],
        'automation_template_tag_label_too_long',
      );
    }
    return label;
  }

  /** List a template's tags, label order. The controller has already resolved the template + authorized. */
  async list(
    context: TenantContext,
    templateId: string,
  ): Promise<readonly AutomationTemplateTagRow[]> {
    return this.database.read(context, (runner) =>
      this.tags.listForTemplate(runner, context, templateId),
    );
  }

  /**
   * Add a normalised tag to a template. A duplicate `(template, label)` is a 409 decided by a
   * tenant-scoped pre-read inside the same transaction, before the insert; the unique key backs it. The
   * controller has already resolved the template within the tenant and authorized the actor.
   */
  async add(
    context: TenantContext,
    templateId: string,
    rawLabel: unknown,
  ): Promise<AutomationTemplateTagRow> {
    const label = AutomationTemplateTagsService.normalizeLabel(rawLabel);
    return this.database.transaction(context, async (tx) => {
      const existing = await this.tags.findByLabel(tx, context, templateId, label);
      if (existing) {
        throw new ApiError(
          409,
          'conflict',
          'That tag is already on this template.',
          undefined,
          'automation_template_tag_duplicate',
        );
      }
      return this.tags.create(tx, context, { templateId, label, createdBy: context.userId });
    });
  }

  /**
   * Remove one tag from a template, idempotently. A missing tag is a no-op (the controller answers
   * 204 regardless). The controller has already resolved the template within the tenant and authorized.
   */
  async remove(context: TenantContext, templateId: string, tagId: string): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.tags.deleteForTemplate(tx, context, templateId, tagId),
    );
  }

  /**
   * List the acting tenant's templates carrying a tag, for the list filter. The label is normalised
   * the same way an added label is, so the filter matches what was stored; an empty label is a 400.
   */
  async templatesByTag(
    context: TenantContext,
    rawLabel: unknown,
  ): Promise<readonly WorkflowTemplateRow[]> {
    const label = AutomationTemplateTagsService.normalizeLabel(rawLabel);
    return this.database.read(context, (runner) =>
      this.tags.listTemplatesByTag(runner, context, label),
    );
  }
}
