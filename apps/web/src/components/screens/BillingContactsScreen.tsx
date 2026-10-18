'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addBillingContact,
  listBillingContacts,
  removeBillingContact,
  type BillingContactView,
} from '../../lib/api/billing-contacts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface BillingContactsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Billing contacts (Billing module 19, x199).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing (billing contacts). This screen owns the list of
 * people a studio nominates for its billing and account notices — each a name, an email and an optional
 * role — and lets a manager add and remove them. It is disjoint from the billing profile and seats
 * screens.
 *
 * The reads and writes are gated on the server by `org.manage` — owners only — so a member who opens
 * this screen sees the API's 403 rather than a blank page. No email is sent to a contact (delivery is
 * Needs-Peter) and no payment instrument is ever stored — contacts only.
 */
export function BillingContactsScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingContactsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const contacts = useQuery({
    queryKey: ['billing-contacts', organizationSlug],
    queryFn: () => listBillingContacts(api, organizationSlug),
  });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['billing-contacts', organizationSlug] });

  const add = useMutation({
    mutationFn: () =>
      addBillingContact(api, organizationSlug, {
        name: name.trim(),
        email: email.trim(),
        role: role.trim() === '' ? null : role.trim(),
      }),
    onSuccess: async () => {
      setName('');
      setEmail('');
      setRole('');
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (contact: BillingContactView) =>
      removeBillingContact(api, organizationSlug, contact.id),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const rows = contacts.data?.contacts ?? [];
  const canAdd = name.trim() !== '' && email.trim() !== '' && !add.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing"
      title="Billing contacts"
      description="Nominate the people who receive your billing and account notices."
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-contact-add-heading">
          <h2 id="tm-contact-add-heading" className="tm-eyebrow">
            Add a contact
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAdd) add.mutate();
            }}
          >
            <Field
              label="Name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <Field
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              hint="Where billing notices for this contact would be sent."
              required
            />
            <Field
              label="Role"
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              hint="Optional — e.g. Accounts payable."
            />

            {add.isError ? (
              <InlineAlert tone="danger" title="Could not add the contact" live>
                {describeError(add.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={add.isPending}
                loadingLabel="Adding"
                disabled={!canAdd}
              >
                Add contact
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-contact-list-heading"
        >
          <h2 id="tm-contact-list-heading" className="tm-eyebrow">
            Contacts {contacts.isSuccess ? `(${rows.length})` : ''}
          </h2>

          {contacts.isError ? (
            <InlineAlert tone="danger" title="Could not load the contacts" live>
              {describeError(contacts.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title="Could not remove the contact" live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {contacts.isPending ? (
            <LoadingRegion label="Loading the contacts.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {contacts.isSuccess && rows.length === 0 ? (
            <InlineAlert tone="neutral" title="No billing contacts yet">
              Add a contact with the form to nominate who receives your billing notices.
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                The organization&rsquo;s billing contacts.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((contact) => (
                  <tr key={contact.id}>
                    <td>{contact.name}</td>
                    <td>{contact.email}</td>
                    <td>{contact.role ?? '—'}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={remove.isPending && remove.variables?.id === contact.id}
                        loadingLabel="Removing"
                        onClick={() => remove.mutate(contact)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
