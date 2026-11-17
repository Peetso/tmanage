import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { CLIENT_JOURNEY_STEP_KINDS } from '../../common/database/schema.js';
import type { ClientJourneyStepKind, ClientJourneyStepRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { TemplatePacksRepository } from '../projects/template-packs.repository.js';
import { findPackJourney, findTemplatePack } from '../projects/template-packs.catalog.js';
import type { PackJourneyStep } from '../projects/template-packs.catalog.js';
import { JourneyStepsRepository } from './journey-steps.repository.js';
import type { JourneyStepChange, NewJourneyStep } from './journey-steps.repository.js';

/** 52-27. The DI token of {@link JourneyStepsService}. */
export const JOURNEY_STEPS_SERVICE = Symbol.for('tmanage.JourneyStepsService');

/** ≤ 50 steps per client and project (plan 52-27 STRIDE, D). */
export const MAX_JOURNEY_STEPS = 50;
const MAX_TITLE = 200;

/** One step as the studio sees it. */
export interface JourneyStepView {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly sequence: number;
  readonly kind: ClientJourneyStepKind;
  readonly title: string;
  readonly refId: string | null;
  /** The form step's answers are stored (the submission is in the form's triage list). */
  readonly answered: boolean;
}

/** A journey template an installed pack offers. */
export interface JourneyTemplateView {
  readonly packKey: string;
  readonly key: string;
  readonly name: string;
  readonly steps: readonly PackJourneyStep[];
}

export function toStepView(row: ClientJourneyStepRow): JourneyStepView {
  return {
    id: row.id,
    clientOrganizationId: row.clientOrganizationId,
    sequence: row.sequence,
    kind: row.kind,
    title: row.title,
    refId: row.refId,
    answered: row.evidenceId !== null,
  };
}

const invalid = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The request body is invalid', [{ field, message }]);

function text(value: unknown, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '' || trimmed.length > MAX_TITLE) {
    throw invalid(field, `must be 1 to ${MAX_TITLE} characters`);
  }
  return trimmed;
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 36) {
    throw invalid(field, 'must be an id');
  }
  return value;
}

function kindOf(value: unknown): ClientJourneyStepKind {
  if (!(CLIENT_JOURNEY_STEP_KINDS as readonly unknown[]).includes(value)) {
    throw invalid('kind', `must be one of ${CLIENT_JOURNEY_STEP_KINDS.join(', ')}`);
  }
  return value as ClientJourneyStepKind;
}

/** `refId` in a body: absent, `null` (unlink), or an id; an upload step never names one. */
function refOf(value: unknown, kind: ClientJourneyStepKind): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (kind === 'upload') throw invalid('refId', 'an upload step does not link an object');
  return id(value, 'refId');
}

/**
 * 52-27 — the studio's half of client journeys: lay out the steps a client works through on one
 * project, by hand or from a journey template an installed pack offers, and link each step to its
 * work form, signature request or meeting.
 *
 * Every call is `project.manage` on the path's project, re-checked here with the real evaluator
 * (a project the caller cannot manage is a `404`). A step's client must be one the project is
 * shared with, and a linked object must be this studio's form or this project's request or
 * meeting, so a step can never point a client at another project's object.
 */
export class JourneyStepsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly steps: JourneyStepsRepository = new JourneyStepsRepository(),
    private readonly packs: TemplatePacksRepository = new TemplatePacksRepository(),
  ) {}

  private requireManage(
    context: TenantContext,
    principal: Principal,
    projectId: string | null,
  ): void {
    const { allowed } = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'journey_project');
    }
  }

  async list(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly JourneyStepView[]> {
    this.requireManage(context, principal, projectId);
    const rows = await this.database.read(context, (runner) =>
      this.steps.listForProject(runner, context, projectId),
    );
    return rows.map(toStepView);
  }

  /** Append one step for a client of the project. */
  async create(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<JourneyStepView> {
    this.requireManage(context, principal, projectId);
    const kind = kindOf(body['kind']);
    const step: NewJourneyStep = {
      projectId,
      clientOrganizationId: id(body['clientOrganizationId'], 'clientOrganizationId'),
      kind,
      title: text(body['title'], 'title'),
      refId: refOf(body['refId'], kind) ?? null,
    };
    const [created] = await this.appendAll(context, [step]);
    if (!created) throw new Error('journey step insert returned no row');
    return created;
  }

  /** Append a pack's journey template for a client; the pack must be installed in this studio. */
  async applyTemplate(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<readonly JourneyStepView[]> {
    this.requireManage(context, principal, projectId);
    const packKey = id(body['packKey'], 'packKey');
    const journey = findPackJourney(packKey, id(body['templateKey'], 'templateKey'));
    if (!journey) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'journey_template');
    }
    const clientOrganizationId = id(body['clientOrganizationId'], 'clientOrganizationId');
    const installed = await this.database.read(context, (runner) =>
      this.packs.findByKey(runner, context, packKey),
    );
    if (!installed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'journey_template');
    }
    return this.appendAll(
      context,
      journey.steps.map((step) => ({
        projectId,
        clientOrganizationId,
        kind: step.kind,
        title: step.title,
        refId: null,
      })),
    );
  }

  private async appendAll(
    context: TenantContext,
    steps: readonly NewJourneyStep[],
  ): Promise<readonly JourneyStepView[]> {
    const first = steps[0];
    if (!first) return [];
    return this.database.transaction(context, async (tx) => {
      if (
        !(await this.steps.isProjectClient(
          tx,
          context,
          first.projectId,
          first.clientOrganizationId,
        ))
      ) {
        throw invalid('clientOrganizationId', 'is not a client of this project');
      }
      for (const step of steps) {
        if (step.refId !== null) await this.requireRef(tx, context, step.kind, step.refId, step);
      }
      const existing = await this.steps.listForClient(
        tx,
        context,
        first.projectId,
        first.clientOrganizationId,
      );
      if (existing.length + steps.length > MAX_JOURNEY_STEPS) {
        throw invalid('steps', `a client journey has at most ${MAX_JOURNEY_STEPS} steps`);
      }
      const ids = new Set(await this.steps.append(tx, context, steps));
      const rows = await this.steps.listForClient(
        tx,
        context,
        first.projectId,
        first.clientOrganizationId,
      );
      return rows.filter((row) => ids.has(row.id)).map(toStepView);
    });
  }

  private async requireRef(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: ClientJourneyStepKind,
    refId: string,
    step: { readonly projectId: string },
  ): Promise<void> {
    if (!(await this.steps.refBelongs(runner, context, kind, refId, step.projectId))) {
      throw invalid('refId', 'is not a form, signature request or meeting of this project');
    }
  }

  /** The step on this project, or the same `404` for an unknown, cross-tenant or other-project id. */
  private async stepOn(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    stepId: string,
  ): Promise<ClientJourneyStepRow> {
    const step = await this.steps.findById(runner, context, stepId);
    if (!step || step.projectId !== projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'journey_step');
    }
    return step;
  }

  /** Rename a step or link it to its object; an answered form step keeps its form. */
  async update(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    stepId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<JourneyStepView> {
    this.requireManage(context, principal, projectId);
    return this.database.transaction(context, async (tx) => {
      const step = await this.stepOn(tx, context, projectId, stepId);
      const change: JourneyStepChange = {
        ...(body['title'] === undefined ? {} : { title: text(body['title'], 'title') }),
        ...(body['refId'] === undefined ? {} : { refId: refOf(body['refId'], step.kind) ?? null }),
      };
      if (change.refId !== undefined && step.evidenceId !== null) {
        throw new ApiError(
          409,
          'conflict',
          'This step is already answered',
          undefined,
          'journey_done',
        );
      }
      if (change.refId) await this.requireRef(tx, context, step.kind, change.refId, step);
      await this.steps.update(tx, context, step.id, change);
      const updated = await this.stepOn(tx, context, projectId, stepId);
      return toStepView(updated);
    });
  }

  async remove(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    stepId: string,
  ): Promise<void> {
    this.requireManage(context, principal, projectId);
    await this.database.transaction(context, async (tx) => {
      const step = await this.stepOn(tx, context, projectId, stepId);
      await this.steps.remove(tx, context, step.id);
    });
  }

  /** The journey templates of the packs this studio installed (`project.manage`, org level). */
  async templates(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly JourneyTemplateView[]> {
    this.requireManage(context, principal, null);
    const installed = await this.database.read(context, (runner) =>
      this.packs.listInstalled(runner, context),
    );
    return installed.flatMap((row) =>
      (findTemplatePack(row.packKey)?.journeys ?? []).map((journey) => ({
        packKey: row.packKey,
        key: journey.key,
        name: journey.name,
        steps: journey.steps,
      })),
    );
  }
}
