import type { ApiClient } from './client';

/**
 * Billing contacts — Billing module 19 (x199).
 *
 * This module wraps the contacts API: list the organization's billing contacts, add one, and remove
 * one. The one exported response shape is {@link BillingContactView}, paired Exact with the API's
 * `BillingContactView` in the contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. Only non-secret contact metadata is carried — no card or bank
 * field, by design — and no email is sent to a contact.
 */

/**
 * One billing contact — paired Exact with the API's `BillingContactView`. `organizationId` is absent on
 * both sides: the wire projection never echoes the tenant id.
 */
export interface BillingContactView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string | null;
  readonly createdAt: string;
}

/** The fields an add sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface AddBillingContactInput {
  readonly name: string;
  readonly email: string;
  readonly role?: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/contacts`;
}

/**
 * List the organization's billing contacts. The envelope is inline (not a named interface) so the
 * contracts gate pairs the one element shape, {@link BillingContactView}.
 */
export async function listBillingContacts(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly contacts: readonly BillingContactView[] }> {
  const { data } = await client.request<{ readonly contacts: readonly BillingContactView[] }>({
    path: base(organizationSlug),
  });
  return data;
}

/** Add a billing contact. */
export async function addBillingContact(
  client: ApiClient,
  organizationSlug: string,
  input: AddBillingContactInput,
): Promise<BillingContactView> {
  const { data } = await client.request<BillingContactView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Remove a billing contact. */
export async function removeBillingContact(
  client: ApiClient,
  organizationSlug: string,
  contactId: string,
): Promise<BillingContactView> {
  const { data } = await client.request<BillingContactView>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(contactId)}`,
  });
  return data;
}
