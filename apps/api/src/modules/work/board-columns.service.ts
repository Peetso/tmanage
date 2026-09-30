import { WORK_ITEM_STATES, authorize, isWorkItemState } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkBoardColumnRow } from '../../common/database/schema.js';
import { WorkBoardColumnsRepository } from './board-columns.repository.js';

/**
 * x308's application service — an organization's custom work-board columns (Work module 7).
 *
 * A studio may group its board by columns of its own choosing rather than the fixed default states.
 * A column is a **display grouping over the existing work-item states** (see
 * `0176_work_board_columns.sql`): it carries a `label` and the `stateKey` it groups, and an ordered
 * `position`. Nothing here touches the work-item state machine, and no work item is stored. The
 * three rules that matter live here:
 *
 * ## Writes are org-level; the board read is any member's
 *
 * Defining, editing and removing a column is org configuration, behind `org.manage`; the decorator
 * is the coarse HTTP gate and this service makes the real org-wide, tenant-checked decision. Listing
 * the columns for the board is behind `work.read` — any member who may read the board sees them.
 *
 * ## Resolve the column, tenant-scoped, BEFORE authorizing or writing
 *
 * Edit and remove name a column id; the row is read first, scoped to the acting tenant — a
 * cross-tenant id simply does not resolve, and the answer is the same 404 an absent id gives, before
 * `authorize()` is ever asked and before any write.
 *
 * ## `state_key` is on the state-machine allowlist; a slot is held once
 *
 * `stateKey` must be one of {@link WORK_ITEM_STATES}; anything else is a 400 with no write. An empty
 * `label` is a 400. `position` is unique per studio — a second column claiming an occupied slot is a
 * 409. Editing a column to its own slot is fine, so a PUT that changes only the label is idempotent.
 */

/** The client-facing projection of one board column. Paired in `e2e/contracts`. */
export interface BoardColumnView {
  readonly id: string;
  readonly label: string;
  readonly stateKey: string;
  readonly position: number;
  readonly createdAt: string;
}

export interface DefineBoardColumnInput {
  readonly label: string;
  readonly stateKey: string;
  readonly position: number;
}

export type UpdateBoardColumnInput = DefineBoardColumnInput;

export class WorkBoardColumnsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly columns: WorkBoardColumnsRepository = new WorkBoardColumnsRepository(),
  ) {}

  /** The tenant's board columns, position-ascending. Behind `work.read`. */
  async list(context: TenantContext): Promise<readonly BoardColumnView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.columns.list(runner, context);
      return rows.map(toView);
    });
  }

  /** Define a column. Behind `org.manage`. Bad state key / empty label → 400, taken slot → 409. */
  async define(
    context: TenantContext,
    principal: Principal,
    input: DefineBoardColumnInput,
  ): Promise<BoardColumnView> {
    const label = requiredLabel(input.label);
    const stateKey = requiredStateKey(input.stateKey);
    const position = requiredPosition(input.position);
    return this.database.transaction(context, async (tx) => {
      // POST has no id to resolve; the org-wide capability decision is made before any write.
      this.requireOrgManage(principal, context);
      await this.requireFreeSlot(tx, context, position, null);
      const row = await this.columns.create(tx, context, { label, stateKey, position });
      return toView(row);
    });
  }

  /** Edit a column in place. Behind `org.manage`. Unknown / cross-tenant id → 404, before authorize. */
  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    input: UpdateBoardColumnInput,
  ): Promise<BoardColumnView> {
    const label = requiredLabel(input.label);
    const stateKey = requiredStateKey(input.stateKey);
    const position = requiredPosition(input.position);
    return this.database.transaction(context, async (tx) => {
      // Resolve the column tenant-scoped BEFORE authorize/write: a cross-tenant or absent id is a
      // 404, never a write.
      const existing = await this.columns.findById(tx, context, id);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      this.requireOrgManage(principal, context);
      await this.requireFreeSlot(tx, context, position, id);
      const row = await this.columns.update(tx, context, id, { label, stateKey, position });
      return toView(row);
    });
  }

  /** Remove a column. Behind `org.manage`. Unknown / cross-tenant id → 404, before authorize/write. */
  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const existing = await this.columns.findById(tx, context, id);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      this.requireOrgManage(principal, context);
      await this.columns.delete(tx, context, id);
    });
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience. An
   * internal role holding `org.manage` passes; anyone else is refused, and a cross-tenant principal
   * by the tenant check inside `authorize`. A denial is a 403 with the machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal' as const,
        lifecycle: 'active' as const,
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `work_board_columns.manage:${verdict.code}`,
      );
    }
  }

  /** A board slot is held by at most one column; a second claimant (other than `exceptId`) is a 409. */
  private async requireFreeSlot(
    runner: TenantQueryRunner,
    context: TenantContext,
    position: number,
    exceptId: string | null,
  ): Promise<void> {
    const holder = await this.columns.findByPosition(runner, context, position);
    if (holder && holder.id !== exceptId) {
      throw new ApiError(409, 'conflict', 'A column already occupies this position');
    }
  }
}

function toView(row: WorkBoardColumnRow): BoardColumnView {
  return {
    id: row.id,
    label: row.label,
    stateKey: row.stateKey,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

function requiredLabel(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: 'must be a non-empty string' },
    ]);
  }
  const label = raw.trim();
  if (label.length > 120) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: 'must be 120 characters or fewer' },
    ]);
  }
  return label;
}

function requiredStateKey(raw: unknown): string {
  if (typeof raw !== 'string' || !isWorkItemState(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'stateKey', message: `must be one of: ${WORK_ITEM_STATES.join(', ')}` },
    ]);
  }
  return raw;
}

function requiredPosition(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 999) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'position', message: 'must be an integer between 0 and 999' },
    ]);
  }
  return raw;
}
