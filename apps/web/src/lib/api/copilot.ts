import type { ApiClient } from './client';

/**
 * AI copilot — the `ask` route of Module 16 (Search, command & AI).
 *
 * A single write-shaped read the API serves at `POST .../copilot/ask {question}`, behind the
 * `copilot` per-org feature flag (off → 404) and the `search.use` capability (missing → 403). The
 * response is the full {@link CopilotAnswerView}: the provider's answer, the evidence behind it, the
 * caller's permission boundary, and the next safe (read-only) action. The only provider wired today
 * is the deterministic offline stub, so the call reaches no model and costs nothing (the paid model
 * is Needs-Peter / NS-13).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and {@link CopilotAnswerView} is paired
 * **Exact** with the API projection in the contracts gate so the two shapes cannot drift.
 */

/** Where the caller's reach ends — what the copilot's answer is and is not allowed to draw on. */
export type CopilotPermissionBoundary = {
  readonly scope: 'organization' | 'assigned-projects' | 'client-projection';
  readonly canSee: string;
  readonly cannotSee: string;
};

/** One cited source behind an answer: a human label and an in-app route suffix to open it. */
export type CopilotEvidence = {
  readonly source: string;
  /** An in-app route suffix (never an external URL); the client links to it. */
  readonly link: string;
};

/**
 * The full answer view module 16 requires — paired Exact with the API's `CopilotAnswerView`. The
 * `provider` id lets a consumer tell the offline stub from a future real model.
 */
export interface CopilotAnswerView {
  readonly answer: string;
  readonly evidence: readonly CopilotEvidence[];
  readonly permissionBoundary: CopilotPermissionBoundary;
  readonly nextSafeAction: string;
  readonly provider: string;
}

export async function askCopilot(
  client: ApiClient,
  organizationSlug: string,
  question: string,
): Promise<CopilotAnswerView> {
  const { data } = await client.request<CopilotAnswerView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/copilot/ask`,
    body: { question },
  });
  return data;
}
