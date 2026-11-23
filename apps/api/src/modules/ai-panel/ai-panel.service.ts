import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  TmanageAiStatus,
  TmanageAiUnavailableReason,
} from '../copilot/copilot-chat.service.js';
import type { AiAccessSwitches } from '../oauth/ai-access.js';
import type { AiPanelAppView } from '../oauth/grants.service.js';

/**
 * **`GET …/ai/panel`: one small answer that lays out the AI panel (gap 4, Fable 5.2 ruling).**
 *
 * One request decides tabs or no tabs, the "not on" state and whether its owner or member version
 * shows, the connected-apps cards and the "Your AI" count. Every flag is a decision the server
 * made (AR-9); the panel draws it.
 *
 * - `tmanageAi`: the chat's own gates in the chat's order (`tmanageAiStatusOf`): on the test list,
 *   the module flag, the owner's switch, the pool key, then this member's block. `canManage` is the
 *   right to open Settings > AI (`mayManageAiSettings`: the workspace owner), not the connected-apps
 *   owner (`org.security.manage`): they can be different people.
 * - `ownAi`: the member's own AI apps over MCP: the platform switch, then the workspace switch.
 *   `canManage` is the workspace AI-apps switch (`org.security.manage`).
 * - `apps`: the member's own live connections; the mark and "Open" from the verified client id.
 * - `pendingApprovals`: the member's own waiting actions, counted as the list counts them.
 *
 * It returns no setting beyond these.
 */

export type OwnAiOffReason = 'platform_off' | 'workspace_off';

export interface AiPanelView {
  readonly tmanageAi: {
    readonly inPlan: boolean;
    readonly enabled: boolean;
    readonly available: boolean;
    readonly reason: TmanageAiUnavailableReason | null;
    readonly canManage: boolean;
  };
  readonly ownAi: {
    readonly enabled: boolean;
    readonly reason: OwnAiOffReason | null;
    readonly canManage: boolean;
  };
  readonly apps: readonly AiPanelAppView[];
  readonly pendingApprovals: number;
}

/** Who asks: the two management rights, decided by their owners' rules. */
export interface AiPanelCaller {
  /** `mayManageAiSettings(principal)` (copilot). */
  readonly mayManageTmanageAi: boolean;
  /** `isAiOwner(role)` (oauth). */
  readonly mayManageOwnAi: boolean;
}

export interface AiPanelDeps {
  readonly tmanageAi: (context: TenantContext) => Promise<TmanageAiStatus>;
  readonly switches: Pick<AiAccessSwitches, 'platformOn' | 'organizationOn'>;
  readonly apps: (context: TenantContext) => Promise<AiPanelAppView[]>;
  readonly pendingCount: (context: TenantContext) => Promise<number>;
}

export class AiPanelService {
  constructor(private readonly deps: AiPanelDeps) {}

  async view(context: TenantContext, caller: AiPanelCaller): Promise<AiPanelView> {
    const [tmanageAi, platformOn, organizationOn, apps, pendingApprovals] = await Promise.all([
      this.deps.tmanageAi(context),
      this.deps.switches.platformOn(context.correlationId),
      this.deps.switches.organizationOn(context.organizationId, context.correlationId),
      this.deps.apps(context),
      this.deps.pendingCount(context),
    ]);
    const ownAiReason: OwnAiOffReason | null = !platformOn
      ? 'platform_off'
      : organizationOn
        ? null
        : 'workspace_off';
    return {
      tmanageAi: { ...tmanageAi, canManage: caller.mayManageTmanageAi },
      ownAi: {
        enabled: ownAiReason === null,
        reason: ownAiReason,
        canManage: caller.mayManageOwnAi,
      },
      apps,
      pendingApprovals,
    };
  }
}
