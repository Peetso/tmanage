import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import type { CreateDocumentInput, ListDocumentsOptions } from './documents.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { DocumentRow } from '../../common/database/schema.js';

/**
 * The application service for DOC-01 (x91) — the object-level decision the route guard cannot
 * make, and the transaction boundary the controller may not open. It follows the `ProjectsService`
 * / `MeetingsService` shape.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse question `doc.read` / `doc.write`: does this
 * role's ceiling include the capability at all. That is all a guard can honestly answer, because
 * no object has been loaded. This service adds the **relation** check with the row's project in
 * hand — an internal member without organization-wide scope reads and writes only the projects
 * they belong to.
 *
 * That relation check is expressed with the sibling `work.read` / `work.create` capabilities
 * rather than with `doc.*`. It is exact, not a shortcut: `doc.read` was declared as a
 * ceiling-mirror of `work.read` and `doc.write` of `work.create` (see
 * `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for every
 * role, and `work.*` is what `authorize()` already relation-gates. Relation-gating `doc.*`
 * directly in `authorize.ts` would be an edit to the security core this slice does not need; a
 * later slice may make it so. Recorded as a decision in the x91 report.
 *
 * No audit event is written yet — like `ProjectsService`'s still-missing outbox event, the audit
 * action for a document is a follow-up (it needs a `doc.*` entry in the `AuditAction` catalog, a
 * domain change out of this slice's scope).
 */

/** What a caller is allowed to see of a document. `organizationId` is deliberately absent. */
export interface DocumentView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `documents` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: DocumentRow): DocumentView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * List a project's documents the principal may read.
   *
   * The tenant filter is the repository's. What this adds is the relation filter: a member
   * without organization-wide scope sees a project's documents only if they belong to that
   * project. Filtered after the read rather than pushed into the query, for the reason
   * `ProjectsService.list` gives — `authorize()` is the single place the relation rule lives, and
   * a `WHERE ... IN (...)` copy would be free to disagree with it.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListDocumentsOptions,
  ): Promise<readonly DocumentView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.documents.list(runner, context, options),
    );

    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: row.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map(toView);
  }

  /**
   * Read one document by id the principal may read.
   *
   * A document the caller may not read — a non-member of its project, or a document in another
   * tenant — is **not found**, never forbidden: 403 would confirm the document exists, and which
   * documents a studio keeps is exactly what a non-member must not be able to probe (the
   * reasoning `ProjectsService.get` gives). The repository has already scoped the read to the
   * tenant, so a cross-tenant id returns null here and never reaches the relation check.
   */
  async get(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<DocumentView> {
    const row = await this.database.read(context, (runner) =>
      this.documents.findById(runner, context, documentId),
    );

    const permitted =
      row !== null &&
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: row.organizationId,
          projectId: row.projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;

    if (!row || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'document_not_visible');
    }

    return toView(row);
  }

  /**
   * Create a document in a project the principal may write to.
   *
   * Two checks run before the write, both surfacing as **not found**, never forbidden — 403 would
   * confirm the project exists, and which projects a studio runs is exactly what a non-member must
   * not be able to enumerate (the reasoning `ProjectsService.get` gives, and the shape
   * `ConversationsService.create` uses):
   *
   * 1. The project is resolved tenant-scoped. A missing id, or one that belongs to another tenant,
   *    is 404. Without this an organization-wide role (which passes the relation check below
   *    regardless of the project) would fall through to the composite foreign key and surface a
   *    **500** — the defect the x90/x92 reviews found in the sibling modules.
   * 2. The relation check: a member without organization-wide scope may write only to a project
   *    they belong to.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateDocumentInput, 'createdByUserId'>,
  ): Promise<DocumentView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: input.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.documents.create(tx, context, { ...input, createdByUserId: context.userId }),
    );

    return toView(row);
  }
}
