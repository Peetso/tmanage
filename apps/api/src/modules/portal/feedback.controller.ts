import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { PortalFeedbackService } from './feedback.service.js';
import type { PortalFeedbackClientView, PortalFeedbackStaffView } from './feedback.service.js';

/**
 * Portal deliverable feedback — x321 (module 13, Client Portal).
 *
 * A controller of its own on the `/portal` path, wired by {@link PortalFeedbackModule}, rather than
 * a method on `PortalController`: it shares no state with the existing portal reads, and keeping it
 * self-contained keeps this slice's files disjoint from the sibling portal slices. The two routes
 * carry different capabilities on purpose — the client *write* is `client_projection.read`, the one
 * capability every client role holds; the staff *read* is `client_member.manage`, which no client
 * role can exercise at audience `internal`. `CapabilityGuard` refuses a role without the annotated
 * capability before the handler runs; the object-level decision (which deliverable, whose client)
 * is {@link PortalFeedbackService}'s.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalFeedbackController {
  constructor(@Inject(PortalFeedbackService) private readonly feedback: PortalFeedbackService) {}

  /**
   * `CL-03` — a client contact rates a published deliverable (1–5, optional comment).
   *
   * `client_projection.read`, the client's one read/write key to the portal. The tenant and the
   * author come from the session, never this body; the body carries only `rating` and `comment`.
   * A re-submit revises the contact's own feedback in place.
   */
  @Post('deliverables/:deliverableId/feedback')
  @RequireCapability('client_projection.read')
  @HttpCode(200)
  async submit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Body() body: { readonly rating?: unknown; readonly comment?: unknown },
  ): Promise<PortalFeedbackClientView> {
    return this.feedback.submit(context, principal, deliverableId, {
      rating: body?.rating,
      comment: body?.comment,
    });
  }

  /**
   * The feedback left on a deliverable — staff read, `client_member.manage`.
   *
   * On the `/portal` path but internal-only in effect: `authorize()` denies any client principal
   * the `internal` audience this read carries, so a client admin who holds `client_member.manage`
   * for their own org still cannot read every contact's feedback here.
   */
  @Get('deliverables/:deliverableId/feedback')
  @RequireCapability('client_member.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
  ): Promise<{ readonly feedback: readonly PortalFeedbackStaffView[] }> {
    return { feedback: await this.feedback.listForDeliverable(context, principal, deliverableId) };
  }
}
