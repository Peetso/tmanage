import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CalendarGridService } from './grid.service.js';
import type { CalendarGridView } from './grid.service.js';

/**
 * CAL week/month grid (x212) — `GET .../meetings/grid?range=week|month&anchor=` behind
 * `meeting.read`. A read-only composition ({@link CalendarGridService}) over `meetings` and the
 * recurrence rules in `meeting_series`, adding no table and no write.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` question — does this role's ceiling
 * include reading meetings at all — and refuses a caller without it (403) before this handler runs
 * (the metadata this decorator sets is what the guard keys off, and what the controller test
 * asserts). The service then adds the **relation** filter with each meeting's project in hand: an
 * internal member without organization-wide scope sees only the meetings of the projects they belong
 * to, exactly as {@link MeetingAgendaController}. Recurrence occurrences are org-scoped (a series
 * names no project) and gated by the `meeting.read` ceiling alone.
 */
@Controller('v1/organizations/:orgSlug/meetings')
export class CalendarGridController {
  constructor(@Inject(CalendarGridService) private readonly grid: CalendarGridService) {}

  /**
   * The acting tenant's grid for the week or month containing `anchor`.
   *
   * `range` (`week`|`month`) and `anchor` (`YYYY-MM-DD`) are both required; a missing or malformed
   * value is a 400 before any read. Every day of the derived window is returned as a cell — a grid
   * draws its empty days — with the concrete meetings and recurrence occurrences that fall on it.
   */
  @Get('grid')
  @RequireCapability('meeting.read')
  async gridView(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('range') range?: string,
    @Query('anchor') anchor?: string,
  ): Promise<CalendarGridView> {
    return this.grid.grid(context, principal, { range, anchor });
  }
}

/**
 * CAL week/month grid (x212) — the wiring for the read-only grid.
 *
 * Its own module, registered in `app.module.ts` beside `CalendarModule`/`MeetingAgendaModule`, so
 * the sibling calendar slices stay file-disjoint (each registers its own module rather than all
 * editing `calendar.module.ts`). The stateless {@link CalendarGridService} is provided by a factory
 * over the global tenant database; it constructs its own (equally stateless) repositories.
 */
@Module({})
export class CalendarGridModule {
  static register(): DynamicModule {
    return {
      module: CalendarGridModule,
      providers: [
        {
          provide: CalendarGridService,
          useFactory: (database: TenantDatabase) => new CalendarGridService(database),
          inject: [TENANT_DATABASE],
        },
      ],
      controllers: [CalendarGridController],
    };
  }
}
