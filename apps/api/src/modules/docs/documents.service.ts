import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { sanitizeDocHtml } from './doc-html.js';
import { isDuplicateKey } from '../tenancy/invitee-accounts.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentsRepository } from './documents.repository.js';
import type { CreateDocumentInput, ListDocumentsOptions } from './documents.repository.js';
import { DocumentVersionsRepository } from './document-versions.repository.js';
import { DocumentTemplatesRepository } from './document-templates.repository.js';
import type { ListDocumentTemplatesOptions } from './document-templates.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type {
  DocumentBodyFormat,
  DocumentRow,
  DocumentTemplateRow,
  DocumentVersionRow,
} from '../../common/database/schema.js';

/** R5 slice 2: how a version is saved — its format, and the version the editor started from. */
export interface SaveVersionOptions {
  /** `html` bodies are sanitised (R5-SPEC §3) before they are stored; default `markdown`. */
  readonly format?: DocumentBodyFormat;
  /** The newest `versionNo` the caller loaded; a newer save since is 409 `DOC_VERSION_CONFLICT`. */
  readonly expectedVersionNo?: number;
  /** The route's tenant slug: same-site image URLs in an `html` body name it. */
  readonly orgSlug?: string;
}

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
 * No audit event is written for create/save yet. B4's rename is the first document write that
 * records one (`document.renamed`) and appends an outbox event (`document.renamed.v1`).
 */

/** What a caller is allowed to see of a document. `organizationId` is deliberately absent. */
export interface DocumentView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  /** R5 (0272): `markdown` (legacy) or sanitised `html`. */
  readonly bodyFormat: DocumentBodyFormat;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * F2 (0227). Who last renamed the document — present only once it has been renamed. The editor
   * names this person when another writer's rename makes the caller's rename a 409.
   */
  readonly titleUpdatedByUserId?: string;
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
    bodyFormat: row.bodyFormat ?? 'markdown',
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.titleUpdatedByUserId ? { titleUpdatedByUserId: row.titleUpdatedByUserId } : {}),
  };
}

/**
 * DOC-02/DOC-03 (x112). What a caller is allowed to see of one document version. `organizationId`
 * is deliberately absent, for the reason {@link DocumentView} omits it — the wire projection never
 * echoes the tenant id (`25-AUTH` §7).
 */
export interface DocumentVersionView {
  readonly id: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly body: string;
  /** R5 (0272): the format this snapshot was saved in. */
  readonly bodyFormat: DocumentBodyFormat;
  readonly editedByUserId: string;
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toVersionView(row: DocumentVersionRow): DocumentVersionView {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNo: row.versionNo,
    body: row.body,
    bodyFormat: row.bodyFormat ?? 'markdown',
    editedByUserId: row.editedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * DOC-04/ADM-06 (x119). What a caller is allowed to see of one document template. `organizationId`
 * is deliberately absent, for the reason {@link DocumentView} omits it — the wire projection never
 * echoes the tenant id (`25-AUTH` §7).
 */
export interface DocumentTemplateView {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toTemplateView(row: DocumentTemplateRow): DocumentTemplateView {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    body: row.body,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DocumentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: DocumentsRepository = new DocumentsRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly versions: DocumentVersionsRepository = new DocumentVersionsRepository(),
    private readonly templates: DocumentTemplatesRepository = new DocumentTemplatesRepository(),
    /** B4: optional so a suite can construct the service without audit or the outbox. */
    private readonly audit?: AuditService,
    private readonly outbox?: OutboxEventsRepository,
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

  /**
   * Resolve a document the principal may act on, tenant-scoped **before** the relation check.
   *
   * This is the Known-trap order (FAST-PROTOCOL 19:55, `MeetingsService.create` after `75e2913`):
   * the document is read scoped to the tenant first, so a missing id — or one that belongs to
   * another tenant — returns null here and becomes a **404**, never a foreign-key 500 reached by an
   * org-wide caller who would pass the relation check regardless. A document the caller may not act
   * on is also 404, never 403, for the reason {@link get} gives: 403 would confirm the document
   * exists, which is exactly what a non-member must not be able to probe.
   *
   * `capability` is `work.read` for a read and `work.create` for a write — the sibling capabilities
   * `doc.read`/`doc.write` mirror by construction and that `authorize()` already relation-gates
   * (see the class comment).
   */
  private async requireActionable(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<DocumentRow> {
    const row = await this.database.read(context, (runner) =>
      this.documents.findById(runner, context, documentId),
    );

    const permitted =
      row !== null &&
      authorize({
        principal,
        capability,
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
    return row;
  }

  /**
   * DOC-03. List a document's versions, newest first, for a caller who may read the document.
   */
  async listVersions(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<readonly DocumentVersionView[]> {
    await this.requireActionable(context, principal, documentId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.versions.list(runner, context, documentId),
    );
    return rows.map(toVersionView);
  }

  /**
   * DOC-03 compare. Read one snapshot of a document by its version number. A version number that
   * does not exist for this document is 404, the same not-found the document itself uses.
   */
  async getVersion(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    versionNo: number,
  ): Promise<DocumentVersionView> {
    await this.requireActionable(context, principal, documentId, 'work.read');
    const row = await this.database.read(context, (runner) =>
      this.versions.findByVersionNo(runner, context, documentId, versionNo),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'version_not_visible');
    }
    return toVersionView(row);
  }

  /**
   * DOC-02. Save a new version: append an immutable snapshot of the body and bump the document's
   * current body, in one transaction. `doc.write`, relation-gated as `work.create`.
   *
   * R5 slice 2: an `html` body is sanitised first (422 `DOC_BODY_INVALID` when nothing survives),
   * and `body_format` is written on both rows. With `expectedVersionNo`, a document whose newest
   * version is any other number is 409 `DOC_VERSION_CONFLICT` and nothing is written; the current
   * number travels as the `currentVersionNo` detail (the error body's only structured channel).
   */
  async saveVersion(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    body: string,
    options: SaveVersionOptions = {},
  ): Promise<DocumentVersionView> {
    await this.requireActionable(context, principal, documentId, 'work.create');
    const bodyFormat = options.format ?? 'markdown';
    const stored =
      bodyFormat === 'html' ? sanitizeDocHtml(body, { orgSlug: options.orgSlug ?? '' }) : body;
    let row: DocumentVersionRow;
    try {
      row = await this.database.transaction(context, async (tx) => {
        if (options.expectedVersionNo !== undefined) {
          const current = await this.versions.latestVersionNo(tx, context, documentId);
          if (current !== options.expectedVersionNo) throw versionConflict(current);
        }
        return this.versions.append(tx, context, {
          documentId,
          body: stored,
          bodyFormat,
          editedByUserId: context.userId,
        });
      });
    } catch (error) {
      // Two saves racing past the read above both compute the same next `version_no`; the
      // unique key refuses the second. That is the same conflict, so it answers 409 with the
      // number that won, not a 500.
      if (!isDuplicateKey(error, 'uq_document_versions_org_doc_version')) throw error;
      const current = await this.database.read(context, (runner) =>
        this.versions.latestVersionNo(runner, context, documentId),
      );
      throw versionConflict(current);
    }
    return toVersionView(row);
  }

  /**
   * DOC-03 restore. Write a NEW version whose body equals a prior snapshot — forward-append, never
   * a mutation of history — and bump the document's current body to it. `doc.write`, relation-gated
   * as `work.create`. A version number that does not exist is 404, and nothing is written.
   */
  async restore(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    versionNo: number,
  ): Promise<DocumentVersionView> {
    await this.requireActionable(context, principal, documentId, 'work.create');

    const source = await this.database.read(context, (runner) =>
      this.versions.findByVersionNo(runner, context, documentId, versionNo),
    );
    if (!source) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'version_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.versions.append(tx, context, {
        documentId,
        body: source.body,
        bodyFormat: source.bodyFormat,
        editedByUserId: context.userId,
      }),
    );
    return toVersionView(row);
  }

  /**
   * B4. Rename a document. The same permission as editing it — `doc.write` on the route, then the
   * `work.create` relation check through {@link requireActionable} (unknown, cross-tenant or
   * not-a-member is 404). Optimistic: `expectedUpdatedAt` is the `updatedAt` the caller last read;
   * a document saved or renamed since is 409 `version_conflict` and nothing is written. An
   * unchanged title is a no-op (no write, no audit, no event). The audit row and the
   * `document.renamed.v1` event carry ids only — never the title.
   */
  async rename(
    context: TenantContext,
    principal: Principal,
    documentId: string,
    input: { readonly title: string; readonly expectedUpdatedAt: string },
  ): Promise<DocumentView> {
    const current = await this.requireActionable(context, principal, documentId, 'work.create');
    const conflict = (): ApiError =>
      new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'version_conflict');
    if (current.updatedAt.toISOString() !== input.expectedUpdatedAt) throw conflict();
    if (current.title === input.title) return toView(current);

    const row = await this.database.transaction(context, async (tx) => {
      const renamed = await this.documents.rename(
        tx,
        context,
        documentId,
        current.updatedAt,
        input.title,
      );
      if (!renamed) throw conflict();
      await this.audit?.record(tx, context, {
        action: 'document.renamed',
        objectId: documentId,
        result: 'allowed',
        metadata: { project_id: current.projectId },
      });
      await this.outbox?.append(tx, context, {
        type: 'document.renamed.v1',
        aggregateId: documentId,
        payload: { documentId, projectId: current.projectId },
      });
      return this.documents.requireById(tx, context, documentId);
    });
    return toView(row);
  }

  // ── DOC-04/ADM-06 (x119) — document templates ──────────────────────────────

  /**
   * DOC-04/ADM-06. Create an org-scoped template a person can later apply to a project.
   *
   * A template belongs to the organization, not a project, so the object-level decision is the
   * org-scoped write authorize (`work.create` with `projectId: null` — the sibling capability
   * `doc.write` mirrors it by construction; see the class comment). The route guard already asked
   * the coarse `doc.write` question; this is the authoritative application decision (`25-AUTH` §3
   * step 2, deny-by-default), so a suspended membership or a tenant mismatch is refused here even
   * if the guard were wrong. A denial surfaces as 403 — there is no object to hide on a create, so
   * the not-found masking `create` uses for a project does not apply.
   */
  async createTemplate(
    context: TenantContext,
    principal: Principal,
    input: { readonly name: string; readonly purpose: string; readonly body: string },
  ): Promise<DocumentTemplateView> {
    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'template_write_denied');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.templates.create(tx, context, { ...input, createdByUserId: context.userId }),
    );
    return toTemplateView(row);
  }

  /**
   * DOC-04/ADM-06. List the acting tenant's templates, name-ascending, for a caller who may read.
   *
   * `doc.read`, relation-gated as `work.read` (org-scoped: `projectId: null`, so every member of
   * the organization may read its templates). The repository has already scoped the read to the
   * tenant; the authorize adds the deny-by-default membership/role decision the guard cannot.
   */
  async listTemplates(
    context: TenantContext,
    principal: Principal,
    options: ListDocumentTemplatesOptions = {},
  ): Promise<readonly DocumentTemplateView[]> {
    const permitted = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'template_read_denied');
    }

    const rows = await this.database.read(context, (runner) =>
      this.templates.list(runner, context, options),
    );
    return rows.map(toTemplateView);
  }

  /**
   * DOC-04/ADM-06. Apply a template to a project: create a new document seeded from the template's
   * body. The template is never mutated; the applied document is an ordinary document from then on.
   *
   * This is the Known-trap order (FAST-PROTOCOL 19:55, `MeetingsService.create` after `75e2913`).
   * Both named ids are resolved tenant-scoped **before** any write, so an unknown or cross-tenant
   * id becomes a **404**, never a foreign-key 500 reached by an org-wide caller:
   *
   * 1. The **template** is read scoped to the tenant here. A missing id — or one that belongs to
   *    another tenant — returns null and is a 404, before the document create path runs.
   * 2. The **project** and the relation/authorize check are the existing {@link create} path's,
   *    reused verbatim: it resolves the project tenant-scoped (404 if missing/cross-tenant) and
   *    authorizes `work.create` on it (a non-member is 404, never 403), then inserts the document.
   */
  async applyTemplate(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    options: { readonly projectId: string; readonly title?: string },
  ): Promise<DocumentView> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }

    const title = options.title?.trim() ? options.title.trim() : template.name;

    // Reuse the document create path: it performs the tenant-scoped project resolution, the
    // `work.create` relation/authorize check, and the insert — so apply never duplicates that
    // permission boundary. The template is read-only above and is not touched here.
    return this.create(context, principal, {
      projectId: options.projectId,
      title,
      body: template.body,
    });
  }
}

/** 409 `DOC_VERSION_CONFLICT`; the newest number travels as the `currentVersionNo` detail. */
function versionConflict(current: number): ApiError {
  return new ApiError(
    409,
    'conflict',
    MESSAGES.conflict,
    [{ field: 'currentVersionNo', message: String(current) }],
    'DOC_VERSION_CONFLICT',
  );
}
