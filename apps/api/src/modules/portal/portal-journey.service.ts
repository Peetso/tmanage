import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ClientJourneyStepRow, WorkFormRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PublicFormsRepository } from '../public-forms/public-forms.repository.js';
import {
  checkPublicValues,
  newSubmissionReference,
  toPublicDefinition,
} from '../public-forms/public-forms.validate.js';
import type { PublicFormDefinition } from '../public-forms/public-forms.validate.js';
import { clientReviewOf } from '../approvals/client-review.js';
import type { ClientReview } from '../approvals/client-review.js';
import { deriveJourney } from './portal-journey.js';
import type { PortalJourney } from './portal-journey.js';
import { PortalJourneyRepository } from './portal-journey.repository.js';
import { JourneyStepsRepository } from './journey-steps.repository.js';

const notFound = (reason: string): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, reason);

/**
 * 52-27 — the client's journey through one project, and the form steps it fills in the portal.
 *
 * The project id comes from the path, so the relation check runs **before** any read: for a
 * client, `authorize()` rule 10 admits only projects in `principal.projectIds` (from
 * `project_clients`), so another client's project, a cross-tenant id or an unknown id all fail
 * it and answer the same `404` — a probe learns nothing. The tenant is the session's context, and
 * the journey steps read are the caller's own client organization's only.
 *
 * A form step is the one step the portal completes here: the answers are checked against the
 * form's fields by the 52-20 rules, stored as a `form_submissions` row (the studio triages it with
 * every other submission) and recorded on the step in the same transaction. The other kinds are
 * done by their own screens (upload, e-sign, meeting) and read back as evidence.
 */
export class PortalJourneyService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sources: PortalJourneyRepository = new PortalJourneyRepository(),
    private readonly steps: JourneyStepsRepository = new JourneyStepsRepository(),
    private readonly forms: PublicFormsRepository = new PublicFormsRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether the caller is a client who may act on this project for `capability`. */
  private mayUse(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: 'client_projection.read' | 'client_request.submit',
  ): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }

  async forProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalJourney> {
    const clientOrganizationId = principal.clientOrganizationId;
    if (
      clientOrganizationId === null ||
      !this.mayUse(context, principal, projectId, 'client_projection.read')
    ) {
      throw notFound('portal_journey_not_visible');
    }

    const { client, milestones, versions, approvals } = await this.database.read(
      context,
      async (runner) => {
        const steps = await this.steps.listForClient(
          runner,
          context,
          projectId,
          clientOrganizationId,
        );
        const evidence = await this.steps.evidence(
          runner,
          context,
          projectId,
          clientOrganizationId,
          steps,
        );
        const sources = await this.sources.sources(runner, context, projectId);
        return { client: { steps, evidence }, ...sources };
      },
    );
    const reviews = new Map<string, ClientReview>();
    for (const [versionId, approval] of approvals) {
      const review = clientReviewOf(approval, principal);
      if (review) reviews.set(versionId, review);
    }
    return deriveJourney(projectId, client, milestones, versions, reviews);
  }

  /**
   * The caller's own linked form step and its form. Another client's step, a step on a project
   * the caller cannot read, an unknown id, a step of another kind or one not linked yet are all
   * the same `404`.
   */
  private async ownFormStep(
    context: TenantContext,
    principal: Principal,
    stepId: string,
    capability: 'client_projection.read' | 'client_request.submit',
  ): Promise<{ readonly step: ClientJourneyStepRow; readonly form: WorkFormRow }> {
    const found = await this.database.read(context, async (runner) => {
      const step = await this.steps.findById(runner, context, stepId);
      if (!step || step.clientOrganizationId !== principal.clientOrganizationId) return null;
      if (step.kind !== 'form' || step.refId === null) return null;
      const form = await this.forms.findForm(runner, context, step.refId);
      return form ? { step, form } : null;
    });
    if (!found || !this.mayUse(context, principal, found.step.projectId, capability)) {
      throw notFound('portal_journey_step_not_visible');
    }
    return found;
  }

  /** The form a form step shows: its title and fields under opaque keys, as the public door does. */
  async formDefinition(
    context: TenantContext,
    principal: Principal,
    stepId: string,
  ): Promise<PublicFormDefinition> {
    const { form } = await this.ownFormStep(context, principal, stepId, 'client_projection.read');
    return toPublicDefinition(form.name, form.fieldsJson);
  }

  /**
   * Send a form step's answers. The values are checked against the form's fields (a wrong one is
   * a `400` and stores nothing); a step already answered is a `409`. The submission and the
   * step's evidence are written together, so a step is never done without its stored answers.
   */
  async submitForm(
    context: TenantContext,
    principal: Principal,
    stepId: string,
    rawValues: unknown,
  ): Promise<{ readonly reference: string }> {
    const { step, form } = await this.ownFormStep(
      context,
      principal,
      stepId,
      'client_request.submit',
    );
    if (step.evidenceId !== null) {
      throw new ApiError(409, 'conflict', 'This step is already done', undefined, 'journey_done');
    }
    const values = checkPublicValues(form.fieldsJson, rawValues);
    const reference = newSubmissionReference();

    await this.database.transaction(context, async (tx) => {
      const submissionId = await this.forms.insertSubmission(
        tx,
        context,
        {
          formId: form.id,
          reference,
          valuesJson: JSON.stringify(values),
          language: null,
          state: 'new',
          riskDecision: 'allow',
          riskScore: 0,
          riskReasons: null,
        },
        this.now(),
      );
      if (!(await this.steps.recordFormEvidence(tx, context, step.id, submissionId))) {
        // A second submit raced this one: roll the duplicate submission back.
        throw new ApiError(409, 'conflict', 'This step is already done', undefined, 'journey_done');
      }
    });
    return { reference };
  }
}
