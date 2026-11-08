import type { UpdateWorkItemInput, WorkItemAudience } from './api/work-items';
import { ApiRequestError } from './api/errors';

/** C25: a client company the project is shared with, as the task's client picker lists it. */
export interface ProjectClientChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * C25: the ticked companies. The API's empty list means "every client of the project", so every
 * box is ticked; a listed company the project is no longer shared with is not shown or counted.
 */
export function tickedClientIds(
  projectClients: readonly ProjectClientChoice[],
  listed: readonly string[],
): readonly string[] {
  const ids = projectClients.map((client) => client.id);
  if (listed.length === 0) return ids;
  return ids.filter((id) => listed.includes(id));
}

/**
 * R36 F1: what the "Who can see this?" card shows under the audience buttons.
 *
 * - `hidden` — the item stays internal and nothing is being widened, or the project's clients are
 *   still loading (so "no client" never flashes before the list arrives).
 * - `picker` — "Which clients can see this?", one box per client company of the project. Shown for
 *   every client-facing audience, one company included: before R36 it needed two or more, so a
 *   project with one client showed nothing to tag.
 * - `no-client` — the project is shared with no client company: say so, with the way to add one.
 */
export type ClientPickerMode = 'hidden' | 'picker' | 'no-client';

export function clientPickerMode(
  audience: WorkItemAudience,
  pending: WorkItemAudience | undefined,
  clientsLoaded: boolean,
  projectClientCount: number,
): ClientPickerMode {
  const clientFacing = audience !== 'internal' || (pending !== undefined && pending !== 'internal');
  if (!clientFacing || !clientsLoaded) return 'hidden';
  return projectClientCount > 0 ? 'picker' : 'no-client';
}

/**
 * R36 F1: the PATCH that widens an item. The companies ticked in the confirm travel in the same
 * request as the audience, so the item is never published to every client first and narrowed
 * afterwards. All ticked is sent as all (the server stores that as "every client").
 */
export function widenRequest(
  version: number,
  audience: WorkItemAudience,
  chosen: readonly string[],
  projectClientCount: number,
): UpdateWorkItemInput {
  if (audience === 'internal' || projectClientCount === 0) return { version, audience };
  return { version, audience, clientOrganizationIds: chosen };
}

/**
 * R36 F1: "Client action needed" asks a client to act, and the API refuses it on a project with
 * no client (422 "link a client to this project first") — so the confirm does not offer it then.
 */
export function mayConfirmAudience(
  audience: WorkItemAudience,
  projectClientCount: number,
  chosenCount: number,
): boolean {
  if (audience === 'internal') return true;
  if (projectClientCount === 0) return audience === 'client_visible';
  return chosenCount > 0;
}

/**
 * R36 F1: a refused audience change as one sentence for the card itself. Before R36 it went to
 * the alert at the top of the screen, out of sight of the button that was pressed, so a refusal
 * looked like a button that did nothing. The field message ("link a client to this project
 * first") is the part a person can act on, so it comes first.
 */
export function audienceFailureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  const fields = error.fieldErrors();
  return fields.get('audience') ?? fields.get('clientOrganizationIds') ?? error.message;
}
