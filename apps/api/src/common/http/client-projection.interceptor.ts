import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { findForbiddenClientFields } from '@tmanage/domain';
import { ApiError, MESSAGES } from './errors.js';

/**
 * The last thing between a client-facing response and the wire — SEC-001.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` §7 lists the fields a client must never see —
 * "internal notes, private comments/messages, estimates/cost/margin, staff evaluation, internal
 * risk rationale, security metadata, other-client identities, hidden custom fields, unreleased
 * versions, and internal file keys" — and `findForbiddenClientFields` has expressed that list in
 * `packages/domain` since AUD-001's neighbour landed.
 *
 * **Nothing called it.** That is the gap SEC-001 exists to close: a rule with no enforcement
 * point is a rule that holds exactly as long as everybody remembers it, and §7's own last
 * sentence — "Never implement client access as `serializeInternalObject(); delete fields`" —
 * describes the mistake somebody makes at four in the afternoon.
 *
 * ## What this is, and what it is emphatically not
 *
 * It is **defence in depth, not the control.** The control is that `PortalService` and
 * `ClientRequestsService` build client views field by field and never select an internal row;
 * that is what `25-AUTH` §7 actually requires and it is proved endpoint by endpoint. This
 * interceptor is the check that would have caught the day somebody stopped doing that.
 *
 * A first draft filtered the offending keys out of the response and let it through. That was
 * wrong and is worth recording as wrong: a projection that quietly loses a field is a projection
 * whose author never learns, and the next field they add — one this list does not name — travels
 * all the way to the client. **It refuses instead**, as a 500, because a response this interceptor
 * objects to is a programming error rather than anything the caller did.
 *
 * ## Why it is global rather than bound to `PortalController`
 *
 * A decorator on the controller is one a new client-facing controller can be written without.
 * The path prefix is the thing the API already treats as the client boundary —
 * `PortalController`'s own note calls `/portal` "a path of its own" and a security property
 * rather than a routing preference — so matching on it means a new portal route is covered by
 * existing without anybody remembering to opt in.
 */
@Injectable()
export class ClientProjectionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ url?: string }>();
    if (!isClientPath(request.url)) return next.handle();

    return next.handle().pipe(
      map((body) => {
        const offending = findForbiddenClientFields(body);
        if (offending.length > 0) {
          // The field *names* are safe to carry: they are the keys of a fixed list in
          // `packages/domain`, not values from the row. The value is what would have leaked and
          // it is never touched.
          throw new ApiError(
            500,
            'internal_error',
            MESSAGES.internal,
            undefined,
            `client_projection_blocked:${offending.join(',')}`,
          );
        }
        return body;
      }),
    );
  }
}

/**
 * Whether this request is on the client's side of the boundary.
 *
 * `/portal` as a path segment, so `/v1/organizations/atlas/portal/requests` matches and a
 * project called "portal" in some future path does not. The query string is discarded first: a
 * caller cannot bring themselves into or out of this check by appending to a URL.
 */
function isClientPath(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  const path = url.split('?')[0] ?? '';
  return path.split('/').includes('portal');
}
