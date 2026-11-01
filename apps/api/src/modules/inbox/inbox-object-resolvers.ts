import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import type { DocumentsService } from '../docs/documents.service.js';
import type { MeetingsService } from '../calendar/meetings.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { WorkflowTemplatesRepository } from '../automations/templates.repository.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { mayDownloadFor } from '../files/purpose-policy.js';
import { ProjectsRepository } from '../projects/projects.repository.js';

/**
 * CQ-12 (COL-05, AUT-02) — the inbox's readers for the collaboration notices the relay now
 * writes: a mention in a channel, a comment on a document, a meeting invite, being put on a
 * project, and a rule's test run.
 *
 * Each reader is the object's **own authorized read** (`ConversationsService.get` and the like),
 * exactly as the work-item and request bundles are resolved through theirs, so the inbox decides
 * nothing about access itself: a 404 from the read — absent, deleted, or no longer this person's
 * to see — is `null`, and the bundle is dropped silently (§1's second check). The one object with
 * no service read is a workflow template; it is read tenant-scoped and shown only to a holder of
 * `org.manage`, the capability that runs a rule.
 *
 * R4 slice 12 adds a file under review (`file_asset`, the root of a version chain): a comment, a
 * mention, a resolved thread or a decision. It is read tenant-scoped and shown only when the file
 * download gate's own rule passes — purpose, then `file.download` on the file's project, audience
 * and lifecycle — so a file deleted, moved out of reach or never this person's is dropped. The
 * full gate (`FileDownloadService.resolve`) is not called: it writes a denied audit row for every
 * refusal, and an inbox read is not an attempt to download.
 */

export const COLLABORATION_OBJECT_TYPES = [
  'conversation',
  'document',
  'meeting',
  'project',
  'workflow_template',
  'file_asset',
] as const;
export type CollaborationObjectType = (typeof COLLABORATION_OBJECT_TYPES)[number];

export function isCollaborationObjectType(value: string): value is CollaborationObjectType {
  return (COLLABORATION_OBJECT_TYPES as readonly string[]).includes(value);
}

/** What a bundle shows of an object: its title, a state word, and its project (if it has one). */
export interface ResolvedInboxObject {
  readonly title: string;
  readonly state: string;
  readonly projectId: string | null;
}

export type InboxObjectResolver = (
  context: TenantContext,
  principal: Principal,
  objectId: string,
) => Promise<ResolvedInboxObject | null>;

export type InboxObjectResolvers = Partial<Record<CollaborationObjectType, InboxObjectResolver>>;

/** A 404 from an authorized read means "not yours to see": `null`. Anything else propagates. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export interface InboxObjectServices {
  readonly database: TenantDatabase;
  readonly conversations: Pick<ConversationsService, 'get'>;
  readonly documents: Pick<DocumentsService, 'get'>;
  readonly meetings: Pick<MeetingsService, 'get'>;
  readonly projects: Pick<ProjectsService, 'get'>;
  readonly templates?: Pick<WorkflowTemplatesRepository, 'findById'>;
  readonly files?: Pick<FileAssetsRepository, 'findById'>;
  readonly projectRows?: Pick<ProjectsRepository, 'findById'>;
}

export function createInboxObjectResolvers(services: InboxObjectServices): InboxObjectResolvers {
  const templates = services.templates ?? new WorkflowTemplatesRepository();
  const files = services.files ?? new FileAssetsRepository();
  const projectRows = services.projectRows ?? new ProjectsRepository();
  return {
    file_asset: async (context, principal, id) => {
      if (principal.kind !== 'internal') return null; // The studio inbox; a client has the portal.
      const found = await services.database.read(context, async (runner) => {
        const asset = await files.findById(runner, context, id);
        if (asset === null || asset.deletedAt !== null) return null;
        const project = await projectRows.findById(runner, context, asset.projectId);
        return project === null ? null : { asset, project };
      });
      if (found === null) return null;
      const { asset, project } = found;
      if (!mayDownloadFor(principal.kind, asset.purpose)) return null;
      const allowed = authorize({
        principal,
        capability: 'file.download',
        resource: {
          organizationId: asset.organizationId,
          projectId: asset.projectId,
          audience: asset.audience,
          clientOrganizationId: asset.clientOrganizationId,
          lifecycle: project.archivedAt === null ? 'active' : 'archived',
        },
      }).allowed;
      if (!allowed) return null;
      return { title: asset.name, state: 'file', projectId: asset.projectId };
    },
    conversation: async (context, principal, id) => {
      const view = await orNull(() => services.conversations.get(context, principal, id));
      if (view === null) return null;
      return {
        title: view.name,
        state: view.archivedAt === null ? 'active' : 'archived',
        projectId: view.projectId,
      };
    },
    document: async (context, principal, id) => {
      const view = await orNull(() => services.documents.get(context, principal, id));
      return view === null
        ? null
        : { title: view.title, state: 'document', projectId: view.projectId };
    },
    meeting: async (context, principal, id) => {
      const view = await orNull(() => services.meetings.get(context, principal, id));
      return view === null
        ? null
        : { title: view.title, state: 'meeting', projectId: view.projectId };
    },
    project: async (context, principal, id) => {
      const view = await orNull(() => services.projects.get(context, principal, id));
      return view === null ? null : { title: view.name, state: view.status, projectId: id };
    },
    workflow_template: async (context, principal, id) => {
      const row = await services.database.read(context, (runner) =>
        templates.findById(runner, context, id),
      );
      if (row === null) return null;
      const allowed = authorize({
        principal,
        capability: 'org.manage',
        resource: {
          organizationId: row.organizationId,
          projectId: null,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;
      if (!allowed) return null;
      return { title: row.name, state: row.enabled ? 'live' : 'off', projectId: null };
    },
  };
}
