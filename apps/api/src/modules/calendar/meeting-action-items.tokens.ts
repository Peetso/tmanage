/**
 * Slice-local injection token for the meeting-action-items service (CAL / MTG-03, x266).
 *
 * Declared here rather than in the shared `common/http/tokens.ts` so this slice stays file-disjoint
 * from that append point — the same convention `MEETING_AGENDA_REPOSITORY` (x127) follows for its
 * repository token. The controller injects the service by this token and holds it only as a type.
 */
export const MEETING_ACTION_ITEMS_SERVICE = Symbol('MEETING_ACTION_ITEMS_SERVICE');
