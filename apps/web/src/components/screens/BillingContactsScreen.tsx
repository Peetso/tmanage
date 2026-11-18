'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addBillingContact,
  listBillingContacts,
  removeBillingContact,
  type BillingContactView,
} from '../../lib/api/billing-contacts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
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
  const t = useT();
  const tOr = useTOr();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

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
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('BillingContactsScreen.eyebrow')}
      title={t('BillingContactsScreen.title')}
      description={t('BillingContactsScreen.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-contact-add-heading">
          <h2 id="tm-contact-add-heading" className="tm-eyebrow">
            {t('BillingContactsScreen.addHeading')}
          </h2>
          <form
            ref={firstStep}
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canAdd) add.mutate();
            }}
          >
            <Field
              label={t('BillingContactsScreen.nameLabel')}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <Field
              label={t('BillingContactsScreen.emailLabel')}
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              hint={t('BillingContactsScreen.emailHint')}
              required
            />
            <Field
              label={t('BillingContactsScreen.roleLabel')}
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              hint={t('BillingContactsScreen.roleHint')}
            />

            {add.isError ? (
              <InlineAlert tone="danger" title={t('BillingContactsScreen.errorAddTitle')} live>
                {describeError(t, add.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={add.isPending}
                loadingLabel={t('BillingContactsScreen.adding')}
                disabled={!canAdd}
              >
                {t('BillingContactsScreen.addButton')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-contact-list-heading"
        >
          <h2 id="tm-contact-list-heading" className="tm-eyebrow">
            {t('BillingContactsScreen.contactsHeading')}{' '}
            {contacts.isSuccess ? `(${rows.length})` : ''}
          </h2>

          {contacts.isError ? (
            <InlineAlert tone="danger" title={t('BillingContactsScreen.errorLoadTitle')} live>
              {describeError(t, contacts.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title={t('BillingContactsScreen.errorRemoveTitle')} live>
              {describeError(t, remove.error)}
            </InlineAlert>
          ) : null}

          {contacts.isPending ? (
            <LoadingRegion label={t('BillingContactsScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {contacts.isSuccess && rows.length === 0 ? (
            <TeachingEmptyState
              title={t('BillingContactsScreen.emptyTitle')}
              explanation={tOr(
                'teachEmpty.billingContactsBody',
                'Name the people who handle billing, like your finance team, so everyone knows who to turn to about invoices.',
              )}
              action={
                canUse('billing.manage') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {tOr('teachEmpty.billingContactsAction', 'Add a contact')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">{t('BillingContactsScreen.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('BillingContactsScreen.colName')}</th>
                  <th scope="col">{t('BillingContactsScreen.colEmail')}</th>
                  <th scope="col">{t('BillingContactsScreen.colRole')}</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">
                      {t('BillingContactsScreen.actionsColumn')}
                    </span>
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
                        loadingLabel={t('BillingContactsScreen.removing')}
                        onClick={() => remove.mutate(contact)}
                      >
                        {t('BillingContactsScreen.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </SettingsShell>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BillingContactsScreen.errorApiUnreachable');
  return t('BillingContactsScreen.errorGeneric');
}
