import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import type { DocumentsService } from '../docs/documents.service.js';
import type { MeetingsService } from '../calendar/meetings.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { WorkflowTemplatesRepository } from '../automations/templates.repository.js';

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
 */

export const COLLABORATION_OBJECT_TYPES = [
  'conversation',
  'document',
  'meeting',
  'project',
  'workflow_template',
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
}

export function createInboxObjectResolvers(services: InboxObjectServices): InboxObjectResolvers {
  const templates = services.templates ?? new WorkflowTemplatesRepository();
  return {
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
