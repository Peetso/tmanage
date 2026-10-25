import type { PrincipalKind, PrincipalRole } from '@tmanage/domain';

/**
 * The provider seam of the AI copilot (Module 16 — Search, command & AI).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Search, command & AI` asks for an AI copilot; the
 * search command registry already marks it "deferred (NS-13 / Needs-Peter)" because a real model is
 * an external, paid dependency. This file is the provider-agnostic shell that lets the rest of the
 * copilot be built now: a narrow {@link CopilotProvider} interface, and a {@link LocalStubProvider}
 * that implements it with a deterministic, canned, source-cited answer and **no outbound network and
 * no API key**. A real provider (the paid model) can be dropped in later behind the same interface
 * without touching the service, the controller, or the feature flag — that swap is the Needs-Peter
 * decision, not this slice.
 *
 * ## Why the provider never resolves the flag or the capability
 *
 * A provider only turns a question plus the caller's already-resolved scope into an answer. Whether
 * the copilot is enabled for the org (the `copilot` feature flag) and whether the caller may use it
 * (the `search.use` capability) are decided by {@link CopilotService} before a provider is ever
 * asked. Keeping that out of the provider means a future real provider cannot accidentally widen
 * access, and the stub can be reasoned about as a pure function of its inputs.
 */

/** The caller's resolved scope, handed to the provider so a canned answer can be scope-aware. */
export interface CopilotContext {
  readonly principalKind: PrincipalKind;
  readonly role: PrincipalRole;
  /** Whether the caller's scope is the whole organization rather than an explicit project list. */
  readonly hasOrgWideScope: boolean;
  /** How many projects the caller can reach — never the ids, so no object leaks into an answer. */
  readonly reachableProjectCount: number;
}

/** One cited source behind an answer: a human label and an in-app route suffix to open it. */
export interface CopilotEvidence {
  readonly source: string;
  /** An in-app route suffix (never an external URL); the client links to it. */
  readonly link: string;
}

/** What a provider returns: the answer, its evidence, and the next safe (read-only) action. */
export interface CopilotProviderAnswer {
  readonly answer: string;
  readonly evidence: readonly CopilotEvidence[];
  readonly nextSafeAction: string;
}

/**
 * The seam. A provider is asked a question in the caller's resolved scope and returns an answer
 * view's content. Implementations must not perform a write, and the stub must not touch the network.
 *
 * `ask` may answer synchronously (the offline {@link LocalStubProvider}) or asynchronously (a real
 * model reached over `fetch`, in `copilot.remote.provider.ts`). The service always `await`s it, so a
 * plain value and a `Promise` are both accepted; a remote adapter must still never crash — it falls
 * back to the stub's answer on any failure.
 */
export interface CopilotProvider {
  /** Stable id of the provider, echoed on the answer view so a consumer knows what produced it. */
  readonly id: string;
  ask(
    question: string,
    context: CopilotContext,
  ): CopilotProviderAnswer | Promise<CopilotProviderAnswer>;
}

/** Trim and bound a question so a canned answer never echoes an unbounded string back verbatim. */
function summariseQuestion(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

/**
 * The deterministic, offline copilot provider used until a real model is wired in.
 *
 * It is a pure function of `(question, context)`: the same inputs always produce the same answer,
 * there is no clock, no randomness, and no I/O. The canned answer is honest about being a local
 * stub, cites the in-app surfaces a member can actually open (global search and the command
 * palette), and proposes a read-only next action. Because it never reaches a network or a model, it
 * cannot leak another tenant's data and costs nothing to run in a test or in CI.
 */
export class LocalStubProvider implements CopilotProvider {
  readonly id = 'local-stub';

  ask(question: string, context: CopilotContext): CopilotProviderAnswer {
    const summary = summariseQuestion(question);
    const scopePhrase = context.hasOrgWideScope
      ? 'the records across this organization that your role can open'
      : `the ${context.reachableProjectCount} project(s) you belong to`;

    const answer =
      `The AI copilot is running in offline preview, so this is a guided answer rather than a ` +
      `generated one. For "${summary}", the copilot can only point you at ${scopePhrase}; it ` +
      `never reaches beyond what your permissions already allow, and it makes no changes on its own.`;

    const evidence: CopilotEvidence[] = [
      { source: 'Global search', link: `/search?q=${encodeURIComponent(summary)}` },
      { source: 'Command palette', link: '/search/commands' },
    ];

    const nextSafeAction = `Open global search for "${summary}" to review the underlying records yourself.`;

    return { answer, evidence, nextSafeAction };
  }
}
