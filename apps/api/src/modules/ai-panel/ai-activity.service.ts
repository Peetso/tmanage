import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AiActivityReader, AiToolCallRow } from '../audit/ai-activity.service.js';
import type { KnownAiApp } from '../oauth/known-clients.js';
import type { AiClientLabel } from '../oauth/grants.service.js';
import {
  AI_ACTIVITY_PAGE_SIZE,
  encodeActivityCursor,
  kindOf,
  nameReadFor,
  projectReadFor,
  verbOf,
} from './ai-activity.js';
import type { AiActivityVerb, NameRead } from './ai-activity.js';

/**
 * **`GET …/ai/activity`: what the member's own connected AI did (AI panel gap 1).**
 *
 * The rows are the caller's own MCP tool calls ({@link AiActivityReader}). Each is worded from the
 * registry ({@link verbOf}) and named **at read time, as the member**: the item's own registry
 * read runs through the full guard chain for this member ({@link SubjectNamer}), so a name, and
 * the item's id, appear only for an item the member can open now. A row the member can no longer
 * open, and every row written before the subject keys existed, keeps only its kind ("Read a
 * task") or nothing beyond the verb. The AI app is named from the member's workspace grants by
 * the client's row id; its mark comes from the verified client id, never its display name.
 */

export interface AiActivityItemView {
  readonly id: string;
  readonly at: string;
  readonly verb: AiActivityVerb;
  /** The call did not complete (a tool error or a failure): nothing was read or changed. */
  readonly failed: boolean;
  /** The AI app's registered name; `null` for a personal access token or an unknown client. */
  readonly clientName: string | null;
  readonly app: KnownAiApp | null;
  /** The item kind (`work_item`, `project`, …); `null` for a lookup with no subject. */
  readonly kind: string | null;
  /** How many items a bulk read returned; `null` for one item. */
  readonly count: number | null;
  /** Set only when the member can open the item now. */
  readonly itemId: string | null;
  readonly itemName: string | null;
  /** Set only when the member can open the project now. */
  readonly projectId: string | null;
  readonly projectName: string | null;
}

export interface AiActivityPageView {
  readonly items: readonly AiActivityItemView[];
  /** The `cursor` of the next (older) page; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Runs one registry read as the member and returns the item's name, or `null` (never throws). */
export type SubjectNamer = (
  context: TenantContext,
  orgSlug: string,
  read: NameRead,
) => Promise<string | null>;

export interface AiActivityDeps {
  readonly reader: Pick<AiActivityReader, 'listOwn'>;
  readonly clients: (
    context: TenantContext,
    clientPks: readonly string[],
  ) => Promise<Map<string, AiClientLabel>>;
  readonly namer: SubjectNamer;
}

export class AiActivityService {
  constructor(private readonly deps: AiActivityDeps) {}

  async page(
    context: TenantContext,
    orgSlug: string,
    cursor: Parameters<AiActivityReader['listOwn']>[1],
  ): Promise<AiActivityPageView> {
    const rows = await this.deps.reader.listOwn(context, cursor, AI_ACTIVITY_PAGE_SIZE + 1);
    const page = rows.slice(0, AI_ACTIVITY_PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > AI_ACTIVITY_PAGE_SIZE && last !== undefined
        ? encodeActivityCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    const clientPks = [
      ...new Set(page.map((row) => row.clientId).filter((id): id is string => id !== null)),
    ];
    const labels = await this.deps.clients(context, clientPks);
    const names = this.namesOnce(context, orgSlug);
    const items = await Promise.all(
      page.map((row) => this.item(row, labels.get(row.clientId ?? ''), names)),
    );
    return { items, nextCursor };
  }

  /** One read per distinct item per page, however many rows name it. */
  private namesOnce(
    context: TenantContext,
    orgSlug: string,
  ): (read: NameRead | null) => Promise<string | null> {
    const cache = new Map<string, Promise<string | null>>();
    return (read) => {
      if (read === null) return Promise.resolve(null);
      const key = `${read.op.id} ${JSON.stringify(read.args)}`;
      let found = cache.get(key);
      if (found === undefined) {
        found = this.deps.namer(context, orgSlug, read).catch(() => null);
        cache.set(key, found);
      }
      return found;
    };
  }

  private async item(
    row: AiToolCallRow,
    label: AiClientLabel | undefined,
    names: (read: NameRead | null) => Promise<string | null>,
  ): Promise<AiActivityItemView> {
    const [itemName, projectName] = await Promise.all([
      names(nameReadFor(row.opId, row.targetId, row.projectId)),
      names(projectReadFor(row.projectId)),
    ]);
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      verb: verbOf(row.opId),
      failed: row.outcome !== null && row.outcome !== 'ok',
      clientName: label?.clientName ?? null,
      app: label?.app ?? null,
      kind: kindOf(row.targetKind, row.opId),
      count: row.targetCount,
      itemId: itemName === null ? null : row.targetId,
      itemName,
      projectId: projectName === null ? null : row.projectId,
      projectName,
    };
  }
}
