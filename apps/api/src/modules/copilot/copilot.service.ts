import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { resolveFlags } from '../admin/feature-flags.service.js';
import { selectCopilotProvider } from './copilot.remote.provider.js';
import type { CopilotEvidence, CopilotProvider } from './copilot.provider.js';

/**
 * The logic half of the AI copilot shell (Module 16 — Search, command & AI).
 *
 * It composes the three things the module map asks of the copilot into one "answer view": the
 * provider's answer and evidence, the **permission boundary** describing what the caller may and may
 * not see, and the next safe (read-only) action. The provider seam is injected and chosen by
 * `COPILOT_PROVIDER` (`selectCopilotProvider`): the offline stub by default, or a real `fetch`
 * adapter (Anthropic / OpenAI, in `copilot.remote.provider.ts`) when a key and model are configured.
 * The paid path is coded but OFF unless the environment selects it (Needs-Peter / NS-13); either way
 * this service's contract is unchanged, and a remote adapter fails closed to the stub.
 *
 * ## The two refusals are the whole of this slice's safety
 *
 *   - **Flag off → 404.** The `copilot` per-org feature flag (default off) is resolved from the
 *     existing feature-flag table for the acting tenant. When it is off the module does not exist
 *     for this org, so the request is a `not_found` with the same coarse message any absent resource
 *     gets — no hint that a copilot could be turned on, and no provider is ever asked.
 *   - **Missing capability → 403.** The route is gated by `@RequireCapability('search.use')` (the
 *     same coarse read ceiling the rest of module 16 uses). This service re-asserts that decision
 *     with the real `authorize` before building anything, the defence-in-depth the admin slices use,
 *     so a caller who reached the handler without the capability is a `forbidden` with no answer.
 *
 * Only after both pass, and the question is a non-empty string, does the provider produce an answer.
 */

/** Where the caller's reach ends — what the copilot's answer is and is not allowed to draw on. */
export interface CopilotPermissionBoundary {
  readonly scope: 'organization' | 'assigned-projects' | 'client-projection';
  readonly canSee: string;
  readonly cannotSee: string;
}

/**
 * The full answer view module 16 requires: the answer, its cited evidence, the permission boundary,
 * the next safe action, and the id of the provider that produced it (so a consumer can tell the
 * offline stub from a future real model).
 */
export interface CopilotAnswerView {
  readonly answer: string;
  readonly evidence: readonly CopilotEvidence[];
  readonly permissionBoundary: CopilotPermissionBoundary;
  readonly nextSafeAction: string;
  readonly provider: string;
}

/** The org-wide resource the `search.use` re-assertion authorizes against (no object is loaded). */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

/** Describe the caller's reach from their principal — never naming a specific project or object. */
function boundaryFor(principal: Principal): CopilotPermissionBoundary {
  if (principal.kind === 'client') {
    return {
      scope: 'client-projection',
      canSee: 'the client projection shared with your client organization',
      cannotSee: 'internal project records and other client organizations',
    };
  }
  if (principal.hasOrgWideScope) {
    return {
      scope: 'organization',
      canSee: 'internal records across this organization that your role permits',
      cannotSee: 'anything belonging to another organization',
    };
  }
  return {
    scope: 'assigned-projects',
    canSee: 'the projects you are a member of',
    cannotSee: 'projects you are not a member of, and client-only data',
  };
}

export class CopilotService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly flags: FeatureFlagsRepository = new FeatureFlagsRepository(),
    // `COPILOT_PROVIDER` decides this: `stub` (the default, offline, keyless) or a real `fetch`
    // adapter when a key and model are also set. Nothing configured → the offline stub, so the
    // shipped build makes no network call. Resolved once at construction, not per request.
    private readonly provider: CopilotProvider = selectCopilotProvider(),
  ) {}

  /**
   * Resolve the flag (404 off), re-assert the capability (403), validate the question (400), then
   * ask the provider and assemble the answer view. No write, no network, no object load.
   */
  async ask(
    context: TenantContext,
    principal: Principal,
    question: unknown,
  ): Promise<CopilotAnswerView> {
    // 1. The copilot must be enabled for this org, or it does not exist (404, no provider call).
    await this.requireFlagOn(context);

    // 2. Re-assert the real `search.use` decision before building anything (403, no provider call).
    this.requireSearchUse(principal, context);

    // 3. The question must be a non-empty string.
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new ApiError(400, 'validation_failed', 'A question is required.', [
        { field: 'question', message: 'Provide a non-empty question.' },
      ]);
    }

    const produced = await this.provider.ask(question, {
      principalKind: principal.kind,
      role: principal.role,
      hasOrgWideScope: principal.hasOrgWideScope,
      reachableProjectCount: principal.projectIds.length,
    });

    return {
      answer: produced.answer,
      evidence: produced.evidence,
      permissionBoundary: boundaryFor(principal),
      nextSafeAction: produced.nextSafeAction,
      provider: this.provider.id,
    };
  }

  private async requireFlagOn(context: TenantContext): Promise<void> {
    const rows = await this.database.read(context, (runner) => this.flags.list(runner, context));
    if (!resolveFlags(rows).copilot) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'copilot.flag_off');
    }
  }

  private requireSearchUse(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'search.use',
      resource: orgWideResource(context),
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `copilot.ask:${verdict.code}`,
      );
    }
  }
}
