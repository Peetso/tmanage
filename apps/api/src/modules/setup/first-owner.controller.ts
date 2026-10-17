import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { FirstOwnerLockUnavailableError } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { Public } from '../../common/http/decorators.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { SessionService } from '../identity/session.service.js';
import { FirstOwnerEmailTakenError } from './first-owner.repository.js';
import {
  FirstOwnerSetupUnavailableError,
  FirstOwnerTokenRejectedError,
  type FirstOwnerAvailabilityView,
  type FirstOwnerService,
  type FirstOwnerSetupBody,
  type FirstOwnerSetupView,
} from './first-owner.service.js';
import {
  FIRST_OWNER_ADMISSION,
  FIRST_OWNER_SERVICE,
  FIRST_OWNER_SESSIONS,
} from './first-owner.tokens.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

/**
 * First-owner setup — how a fresh production install gets its first organisation owner, since
 * there is no public sign-up.
 *
 * This controller is registered only when `SETUP_TOKEN` is set (see `app.module`). Even when it
 * is registered, both routes answer with the same 404 as an unknown route as soon as any
 * organisation exists, so a finished install reveals nothing about this door.
 *
 *  - `GET /public/setup` — `{available: true}` while setup is still possible, else 404.
 *  - `POST /public/setup` — rate-limited per address *before anything else*, then hands the body
 *    (setup token, organisation and owner details) to {@link FirstOwnerService}, which compares
 *    the token in constant time and creates the organisation and owner inside one locked
 *    transaction. On success the owner is signed in exactly as `AuthenticationController` does it.
 *
 * The setup token travels only in the POST body: never in a URL, never in a log line, never in an
 * error message.
 */
@Controller('public/setup')
export class FirstOwnerController {
  constructor(
    @Inject(FIRST_OWNER_SERVICE) private readonly service: FirstOwnerService,
    @Inject(FIRST_OWNER_SESSIONS) private readonly sessions: SessionService,
    @Inject(FIRST_OWNER_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  @Get()
  @Public()
  async availability(@Req() request: RequestLike): Promise<FirstOwnerAvailabilityView> {
    const state = requireRequestState(request);
    if (!(await this.service.isAvailable(state.correlationId))) throw notFound();
    return { available: true };
  }

  @Post()
  @Public()
  @HttpCode(201)
  async setup(
    @Body() body: FirstOwnerSetupBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<FirstOwnerSetupView> {
    const state = requireRequestState(request);
    if (!this.admit(request.ip ?? 'unknown')) {
      // Before the service: a refused caller never reaches the token comparison or the database.
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }

    const result = await this.run(() => this.service.setup(body, state.correlationId));

    const userAgent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId: result.userId,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      correlationId: state.correlationId,
    });
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
      organizationSlug: result.slug,
    };
  }

  /** Translate the service's refusals. None of them carries the token or why it was wrong. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof FirstOwnerSetupUnavailableError) throw notFound();
      if (error instanceof FirstOwnerTokenRejectedError) {
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          'setup_token_rejected',
        );
      }
      if (error instanceof FirstOwnerLockUnavailableError) {
        throw new ApiError(409, 'conflict', 'Setup is already in progress. Try again in a moment.');
      }
      if (error instanceof FirstOwnerEmailTakenError) {
        throw new ApiError(409, 'conflict', 'That email address is already in use', [
          { field: 'email', message: 'already in use' },
        ]);
      }
      throw error;
    }
  }
}

/** Identical to the 404 the exception filter renders for an unknown route. */
function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}
