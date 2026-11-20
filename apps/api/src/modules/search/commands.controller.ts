import { Controller, Get, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { COMMAND_REGISTRY } from './command-registry.js';
import { MAX_COMMAND_RESULTS, matchCommands } from './command-match.js';
import type { CommandDefinition, CommandKind } from './command-match.js';

/**
 * SRCH command palette (x181) — the command surface of module 16 (Search, command & AI).
 *
 * `38-MODULE-MAP` §Search, command & AI asks for a command palette: keyboard-driven navigation and a
 * few safe quick actions over the existing search (audit #8, Search Partial — only basic/ranked
 * search is built). This controller serves the palette's contents: `GET …/search/commands?q=`, a
 * bounded, relevance-ordered list drawn from the static registry by the pure matcher. The AI copilot
 * is out of scope (Needs-Peter, external LLM).
 *
 * A second controller on the search base path rather than an edit to {@link SearchController}, so the
 * command slice stays file-disjoint from the ranked-search slice (x111/x148). It shares the
 * `search.use` gate — the same coarse ceiling global search reads under — so no new capability and no
 * `capabilities.ts` edit. No database, no tenant object to resolve, no write, no migration: the
 * registry is code, and the matcher is pure, so this route is a deterministic read of a build-time
 * constant, tenant-guarded only so the palette is offered to members of this organization.
 *
 * ## The command shape is deliberately distinct from a search hit
 *
 * A search hit ({@link SearchResultView}) is a row — a work item, document or meeting with a
 * `projectId` and a `snippet`. A command is not a row: it is a fixed navigation or an allowlisted
 * quick action. Keeping {@link CommandView} a separate shape (its own `kind` union, an `href` xor an
 * `action`) means the palette can merge commands and recent-search entries without either masquerading
 * as the other, and a consumer can never read a command's `action` as if it were a search result.
 */

/** What a caller is allowed to see of one command. `href` xor `action` is set by `kind`. */
export interface CommandView {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly kind: CommandKind;
  /** For a `navigate` command, the in-app route suffix to link to; null for an `action`. */
  readonly href: string | null;
  /** For an `action` command, the allowlisted action id the client dispatches; null for a `navigate`. */
  readonly action: string | null;
}

@Controller('v1/organizations/:orgSlug/search/commands')
export class CommandsController {
  /**
   * The palette's contents. An empty `q` returns the default set (the registry in order, bounded);
   * a non-empty `q` returns the matches in score order. `limit` is optional and bounded; anything
   * that is present but not an integer is a 400, never a silent clamp. The query only ever selects
   * and orders commands that already exist — it is never a source of a command, an href or an action
   * (the no-injection property proved on the matcher).
   */
  @Get()
  @RequireCapability('search.use')
  run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): { readonly commands: readonly CommandView[] } {
    const query = typeof q === 'string' ? q : '';

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 1 || value > MAX_COMMAND_RESULTS) {
        throw new ApiError(400, 'validation_failed', 'limit is invalid', [
          {
            field: 'limit',
            message: `must be a whole number between 1 and ${MAX_COMMAND_RESULTS}`,
          },
        ]);
      }
      parsedLimit = value;
    }

    const matched = matchCommands(offeredTo(principal, context), query, parsedLimit);
    return {
      commands: matched.map((command) => ({
        id: command.id,
        title: command.title,
        section: command.section,
        kind: command.kind,
        href: command.href,
        action: command.action,
      })),
    };
  }
}

/** The registry minus the commands whose destination this caller would be refused (CQ-06). */
export function offeredTo(
  principal: Principal,
  context: TenantContext,
): readonly CommandDefinition[] {
  return COMMAND_REGISTRY.filter(
    (command) =>
      command.capability === undefined ||
      authorize({
        principal,
        capability: command.capability,
        resource: {
          organizationId: context.organizationId,
          projectId: null,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed,
  );
}

/**
 * x181's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into {@link SearchModule}, so the search slices stay file-disjoint. It depends on
 * nothing: the registry is a constant and the matcher is pure, so there is no provider to construct.
 */
@Module({})
export class CommandsModule {
  static register(): DynamicModule {
    return {
      module: CommandsModule,
      controllers: [CommandsController],
    };
  }
}
