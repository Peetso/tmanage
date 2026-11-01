import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentSharingRepository } from './document-sharing.repository.js';
import type { DocumentsService } from './documents.service.js';

/**
 * R5 slice 2 — "Sara is editing" (R5-SPEC §4). The editor sends a heartbeat every 15 s while it has
 * focus; whoever beat within the last {@link PRESENCE_TTL_MS} is listed.
 *
 * In-memory per process: `Map<orgId:docId, Map<userId, { name, lastSeenAt }>>`, swept on read. That
 * is enough for the single Hostinger Node app; a second instance would need a table (SPEC §5). The
 * key starts with the tenant id from the context, so one studio's editors never reach another's
 * list. Every call first reads the document through `DocumentsService.get` — tenant-scoped and
 * relation-checked, 404 when the caller may not read it — so presence cannot probe a document.
 */

export const PRESENCE_TTL_MS = 30_000;

export interface DocumentEditorView {
  readonly userId: string;
  readonly name: string;
  readonly lastSeenAt: string;
}

interface Seen {
  readonly name: string;
  readonly lastSeenAt: number;
}

export class DocumentPresenceService {
  private readonly editors = new Map<string, Map<string, Seen>>();

  constructor(
    private readonly database: TenantDatabase,
    private readonly documents: Pick<DocumentsService, 'get'>,
    private readonly people: Pick<DocumentSharingRepository, 'people'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** "I am editing this document now." Idempotent; refreshes `lastSeenAt`. */
  async touch(context: TenantContext, principal: Principal, documentId: string): Promise<void> {
    await this.documents.get(context, principal, documentId);
    const key = `${context.organizationId}:${documentId}`;
    const doc = this.editors.get(key) ?? new Map<string, Seen>();
    const name = doc.get(context.userId)?.name ?? (await this.nameOf(context));
    doc.set(context.userId, { name, lastSeenAt: this.now() });
    this.editors.set(key, doc);
  }

  /** Who edited this document within the TTL, the caller included (the editor filters itself). */
  async list(
    context: TenantContext,
    principal: Principal,
    documentId: string,
  ): Promise<readonly DocumentEditorView[]> {
    await this.documents.get(context, principal, documentId);
    const key = `${context.organizationId}:${documentId}`;
    const doc = this.editors.get(key);
    if (!doc) return [];
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const [userId, seen] of doc) if (seen.lastSeenAt < cutoff) doc.delete(userId);
    if (doc.size === 0) this.editors.delete(key);
    return [...doc].map(([userId, seen]) => ({
      userId,
      name: seen.name,
      lastSeenAt: new Date(seen.lastSeenAt).toISOString(),
    }));
  }

  private async nameOf(context: TenantContext): Promise<string> {
    const rows = await this.database.read(context, (runner) =>
      this.people.people(runner, context, { membershipIds: [context.membershipId] }),
    );
    return rows[0]?.displayName ?? '';
  }
}
