/**
 * A tiny, explicit finite state machine.
 *
 * Every governed lifecycle in `23-ERD-AND-STATE-MACHINES.md` is expressed with this type
 * so that "which transitions are legal" is data a test can enumerate, rather than a
 * scatter of `if` statements across service code that nobody can audit as a whole.
 *
 * Transitions may declare `requires` — named facts the caller must supply and that the
 * machine refuses to move without. This is how invariants such as "`done` requires an
 * owner and a completion timestamp" or "leaving `blocked` resolves the active blocker"
 * become mechanically checkable instead of conventions.
 */

/** Result of attempting a transition. Never throws — callers map this onto an API error. */
export type TransitionResult<TState extends string> =
  | { readonly ok: true; readonly state: TState }
  | {
      readonly ok: false;
      readonly reason: 'illegal_transition' | 'missing_requirement';
      /** Stable, non-sensitive detail safe to surface in an API error body. */
      readonly detail: string;
      /** Named facts that were required but not supplied. Empty for an illegal transition. */
      readonly missing: readonly string[];
    };

export interface TransitionDefinition<TState extends string> {
  readonly from: TState;
  readonly to: TState;
  /**
   * Names of facts that must be present and non-null in the supplied context.
   * Named rather than typed so the same machine definition can be enumerated in tests
   * and rendered into documentation.
   */
  readonly requires?: readonly string[];
  /**
   * Names of facts the transition *accepts* but does not demand — the structured owner of a
   * blocker's ask, for instance, which US-B04 wants and §5 does not require. Listed here so a
   * form that renders "what this move takes" can offer them, rather than the machine knowing
   * about a fact only when it is time to refuse for its absence. A fact in `accepts` is
   * never in `requires`; the constructor refuses a definition that says both.
   */
  readonly accepts?: readonly string[];
  /** Why this transition exists, quoting the governing spec. Surfaces in generated docs. */
  readonly note?: string;
}

export interface StateMachineDefinition<TState extends string> {
  readonly name: string;
  readonly initial: TState;
  readonly states: readonly TState[];
  /** States from which no further transition is legal. */
  readonly terminal: readonly TState[];
  readonly transitions: readonly TransitionDefinition<TState>[];
}

/** Facts supplied at transition time. A key present but `null`/`undefined` counts as absent. */
export type TransitionContext = Readonly<Record<string, unknown>>;

export class StateMachine<TState extends string> {
  /** `from` -> `to` -> definition. Built once so `canTransition` is a map lookup. */
  readonly #index: ReadonlyMap<TState, ReadonlyMap<TState, TransitionDefinition<TState>>>;

  constructor(readonly definition: StateMachineDefinition<TState>) {
    const index = new Map<TState, Map<TState, TransitionDefinition<TState>>>();
    for (const transition of definition.transitions) {
      // A duplicated (from, to) pair would silently shadow one definition's `requires`,
      // quietly dropping an invariant. Refuse to construct such a machine.
      const existing = index.get(transition.from)?.get(transition.to);
      if (existing) {
        throw new Error(
          `${definition.name}: duplicate transition ${transition.from} -> ${transition.to}`,
        );
      }
      const overlap = (transition.accepts ?? []).filter((fact) =>
        (transition.requires ?? []).includes(fact),
      );
      if (overlap.length > 0) {
        throw new Error(
          `${definition.name}: ${transition.from} -> ${transition.to} lists ${overlap.join(', ')} as both required and optional`,
        );
      }
      const byTarget = index.get(transition.from) ?? new Map();
      byTarget.set(transition.to, transition);
      index.set(transition.from, byTarget);
    }
    this.#index = index;
  }

  /** Every state reachable from `state` in one legal step. */
  allowedFrom(state: TState): readonly TState[] {
    return [...(this.#index.get(state)?.keys() ?? [])];
  }

  isTerminal(state: TState): boolean {
    return this.definition.terminal.includes(state);
  }

  /** The named facts a transition needs, for building a "what else do you need" prompt. */
  requirementsFor(from: TState, to: TState): readonly string[] {
    return this.#index.get(from)?.get(to)?.requires ?? [];
  }

  /** The named facts a transition will take but does not need — offered, never demanded. */
  optionalFor(from: TState, to: TState): readonly string[] {
    return this.#index.get(from)?.get(to)?.accepts ?? [];
  }

  /**
   * Attempt a transition.
   *
   * Returns a result rather than throwing: an illegal transition is an ordinary
   * client error (409/422), not an exceptional condition, and the caller needs the
   * structured `missing` list to render the form that collects the missing facts.
   */
  transition(from: TState, to: TState, context: TransitionContext = {}): TransitionResult<TState> {
    const definition = this.#index.get(from)?.get(to);
    if (!definition) {
      return {
        ok: false,
        reason: 'illegal_transition',
        detail: `${this.definition.name}: ${from} -> ${to} is not a legal transition`,
        missing: [],
      };
    }

    const missing = (definition.requires ?? []).filter((key) => {
      const value = context[key];
      if (value === undefined || value === null) return true;
      // An empty or whitespace-only string is not a supplied reason.
      if (typeof value === 'string' && value.trim() === '') return true;
      return false;
    });

    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'missing_requirement',
        detail: `${this.definition.name}: ${from} -> ${to} requires ${missing.join(', ')}`,
        missing,
      };
    }

    return { ok: true, state: to };
  }
}
