/**
 * DC-2 / AR-9 / SE-3: the step-up form asks for an authenticator code only when the server says
 * so (`reauthNeedsAuthenticatorCode`, decided in `apps/api/.../identity/reauthentication-code.ts`).
 * The web never defaults that decision: while the answer is loading it is `loading`, and when it
 * could not be read (error, or an answer without the field) it is `unknown` (HT-3). Only `known`
 * lets the form submit.
 */
export type StepUpDecision =
  | { readonly kind: 'known'; readonly needsCode: boolean }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unknown' };

/** The parts of a TanStack query over `GET /v1/auth/factors` this decision reads. */
export interface FactorsQueryState {
  readonly data?: { readonly reauthNeedsAuthenticatorCode?: unknown } | undefined;
  readonly isError: boolean;
}

export function stepUpDecision(query: FactorsQueryState): StepUpDecision {
  const flag = query.data?.reauthNeedsAuthenticatorCode;
  if (typeof flag === 'boolean') return { kind: 'known', needsCode: flag };
  if (query.isError || query.data !== undefined) return { kind: 'unknown' };
  return { kind: 'loading' };
}
