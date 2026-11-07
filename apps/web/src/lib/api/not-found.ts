import { ApiRequestError } from './errors';

/**
 * True when the API answered **404** — the record does not exist, or the caller's tenant
 * cannot see it (the API gives both the same refusal). A route page uses this to call
 * `notFound()` instead of rendering its full screen around a record that is not there.
 */
export function isApiNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}
