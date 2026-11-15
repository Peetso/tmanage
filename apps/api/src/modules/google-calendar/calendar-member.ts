import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow, WorkItemRow } from '../../common/database/schema.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../tenancy/membership-resolver.repository.js';
import { PrincipalRepository } from '../tenancy/principal.repository.js';
import { OrganizationsRepository } from '../tenancy/organizations.repository.js';
import { MyDayRepository } from '../home/my-day.repository.js';
import { MeetingsRepository } from '../calendar/meetings.repository.js';

/**
 * 53-14 — "what this person's calendar may show", shared by the due-date mirror (run by the sync
 * job, which has no session) and the signed-out ICS feed. Both start from a stored user id, so
 * the person is resolved exactly as a request of theirs would be ({@link MembershipResolver}: an
 * inactive, suspended or offboarded membership resolves to nothing), and every row is authorized
 * with that person's own principal (`work.read`), the rule My Day and All meetings apply. Only
 * internal members with `meeting.read` have a calendar here.
 */

export interface CalendarMember {
  readonly context: TenantContext;
  readonly principal: Principal;
  readonly orgSlug: string;
}

export interface CalendarMemberItems {
  readonly due: readonly WorkItemRow[];
  readonly meetings: readonly MeetingRow[];
}

const MAX_ITEMS = 300;
const MAX_MEETINGS = 500;

export class CalendarMemberReader {
  constructor(
    private readonly database: TenantDatabase,
    private readonly memberships: MembershipResolver = new MembershipResolver(database),
    private readonly principals: PrincipalRepository = new PrincipalRepository(),
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(),
    private readonly work: MyDayRepository = new MyDayRepository(),
    private readonly meetingRows: MeetingsRepository = new MeetingsRepository(),
  ) {}

  /** The person as a request of theirs would see them, or `null` when they may not have a feed. */
  async resolve(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<CalendarMember | null> {
    let resolved;
    try {
      resolved = await this.memberships.resolve({
        userId: input.userId,
        organization: { organizationId: input.organizationId },
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) return null;
      throw error;
    }
    const { context } = resolved;
    if (context.organizationId !== input.organizationId || context.principalKind !== 'internal') {
      return null;
    }
    if (!context.capabilities.includes('meeting.read')) return null;
    return this.database.read(context, async (runner) => {
      const organization = await this.organizations.findCurrent(runner, context);
      if (!organization) return null;
      const principal = await this.principals.load(runner, resolved);
      return { context, principal, orgSlug: organization.slug };
    });
  }

  /** The person's open dated work and their meetings in a window, each row authorized. */
  async items(
    member: CalendarMember,
    window: { readonly from: Date; readonly to: Date; readonly withMeetings: boolean },
  ): Promise<CalendarMemberItems> {
    const { context, principal } = member;
    const { due, meetings } = await this.database.read(context, async (runner) => ({
      due: await this.work.listOwnedDue(runner, context, context.userId, {
        from: window.from,
        to: window.to,
        limit: MAX_ITEMS,
      }),
      meetings: window.withMeetings
        ? await this.meetingRows.listForPersonWindow(runner, context, {
            userId: context.userId,
            membershipId: context.membershipId,
            from: window.from,
            to: window.to,
            limit: MAX_MEETINGS,
          })
        : [],
    }));
    const readable = (row: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly audience: WorkItemRow['audience'];
    }) =>
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: row.organizationId,
          projectId: row.projectId,
          audience: row.audience,
          lifecycle: 'active',
        },
      }).allowed;
    return {
      due: due.filter((row) => row.dueAt !== null && readable(row)),
      meetings: meetings.filter((row) => readable({ ...row, audience: 'internal' })),
    };
  }
}
