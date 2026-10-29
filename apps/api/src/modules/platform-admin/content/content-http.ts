import { platformRequestContext } from '../platform-admin.access.js';
import type { SupportRequest } from './support-context.js';

/** The service token every content controller injects (platform-admin v2 · PA-08). */
export const PLATFORM_CONTENT_SERVICE = Symbol.for('tmanage.PlatformContentService');

/** The base path every content route hangs off: one organization, by id. */
export const CONTENT_BASE = 'v1/platform/organizations/:id/content';

/** The request facts a content call needs: correlation, and the request for IP and device. */
export function supportRequestOf(request: object): SupportRequest {
  return { correlationId: platformRequestContext(request).correlationId, request };
}
