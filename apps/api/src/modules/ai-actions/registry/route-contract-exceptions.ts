/**
 * Fix lane B, 2026-11-23. The reasoned exceptions to `route-contract.test.ts` (defect class DC-9,
 * "an action's input schema does not match its route"). Keyed `"<op id> <check>"`; the value is
 * the reason. An entry that no longer matches a finding fails the test, so the list only shrinks.
 */
export const ROUTE_CONTRACT_EXCEPTIONS: Readonly<Record<string, string>> = {
  // The route refuses a call without an `Idempotency-Key` header, and an AI tool call sends no
  // headers (the runtime builds the request from the arguments alone, `mcp/pending-actions.ts`
  // `buildOpRequest`). The staff twin `upload_sessions.create` has no detail for the same reason
  // (`parity-b2.test.ts` DETAIL_LESS_ON_PURPOSE). Exit: the runtime derives the key from the
  // pending action id, or the op loses its detail too.
  'portal.upload_sessions.create example-route':
    'needs an Idempotency-Key header a tool call cannot send',
  'portal.upload_sessions.create required':
    'needs an Idempotency-Key header a tool call cannot send',
};
