import {
  authorize,
  PROJECT_EXPORT_MAX_ITEMS,
  PROJECT_EXPORT_VERSION,
  projectExportCsv,
  projectExportFileName,
} from '@tmanage/domain';
import type {
  Principal,
  ProjectExportDocument,
  ProjectExportFormat,
  ProjectExportItem,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectExportRepository } from './project-export.repository.js';
import { ProjectsRepository } from './projects.repository.js';

/** What the controller sends: the bytes, their type and a safe file name. */
export interface ProjectExportDownload {
  readonly body: Buffer;
  readonly contentType: string;
  readonly fileName: string;
}

const CONTENT_TYPE: Readonly<Record<ProjectExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/**
 * 54-29 — one project's work items as CSV or JSON.
 *
 * The capability guard has already asked "may this person export work in this organization at
 * all" (`work.export`). This asks it again about **this project**, from the row: a project the
 * caller cannot read — another tenant's, or one they are not a member of — is a 404, never a 403,
 * so the route cannot be used to learn which projects exist; a project they can read but not
 * export is a 403. Past {@link PROJECT_EXPORT_MAX_ITEMS} items the answer is 413, not a short
 * file. The export is audited before the bytes leave, and fails closed if the audit row cannot be
 * written.
 */
export class ProjectExportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: Pick<AuditService, 'recordStandalone'>,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly rows: ProjectExportRepository = new ProjectExportRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async export(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    format: ProjectExportFormat,
  ): Promise<ProjectExportDownload> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    const resource = project && {
      organizationId: project.organizationId,
      projectId: project.id,
      audience: 'internal' as const,
      lifecycle: project.archivedAt ? ('archived' as const) : ('active' as const),
    };
    if (
      !project ||
      !resource ||
      !authorize({ principal, capability: 'work.read', resource }).allowed
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    if (!authorize({ principal, capability: 'work.export', resource }).allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_work.export');
    }

    const items = await this.database.read(context, async (runner) => {
      const rows = await this.rows.listItems(
        runner,
        context,
        project.id,
        PROJECT_EXPORT_MAX_ITEMS + 1,
      );
      if (rows.length > PROJECT_EXPORT_MAX_ITEMS) {
        throw new ApiError(
          413,
          'validation_failed',
          `A project export holds at most ${PROJECT_EXPORT_MAX_ITEMS} work items`,
          [
            {
              field: 'export',
              message: `exceeds the ${PROJECT_EXPORT_MAX_ITEMS}-item export limit`,
            },
          ],
        );
      }
      const labels = await this.rows.labelsByItem(
        runner,
        context,
        rows.map((row) => row.id),
      );
      const owners = await this.rows.ownerEmails(
        runner,
        context,
        rows.flatMap((row) => (row.ownerUserId ? [row.ownerUserId] : [])),
      );
      return rows.map((row): ProjectExportItem => ({
        id: row.id,
        title: row.title,
        state: row.state,
        ownerEmail: row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null,
        startAt: row.startAt ? row.startAt.toISOString() : null,
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        labels: labels.get(row.id) ?? [],
        description: row.description ?? null,
      }));
    });

    const at = this.now();
    const text =
      format === 'csv'
        ? projectExportCsv(items)
        : JSON.stringify(
            {
              kind: 'tmanage.project-export',
              version: PROJECT_EXPORT_VERSION,
              exportedAt: at.toISOString(),
              project: { id: project.id, name: project.name },
              items,
            } satisfies ProjectExportDocument,
            null,
            2,
          );

    await this.audit.recordStandalone(context, {
      action: 'project.exported',
      result: 'allowed',
      objectId: project.id,
      actorUserId: principal.userId,
      metadata: { export_format: format, item_count: items.length },
    });

    return {
      body: Buffer.from(text, 'utf-8'),
      contentType: CONTENT_TYPE[format],
      fileName: projectExportFileName(project.name, format, at),
    };
  }
}
