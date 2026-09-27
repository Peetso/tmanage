'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createGlossaryTerm,
  deleteGlossaryTerm,
  listGlossaryTerms,
  updateGlossaryTerm,
} from '../../lib/api/glossary';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { GlossaryTermSummary } from '../../lib/api/glossary';

export interface GlossaryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Org glossary of terms (Docs module, x263).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Docs — the DOC hub's "decision register, glossary". This
 * screen searches the studio's shared vocabulary and, for a member with the doc-authoring capability,
 * adds a term, edits its definition, and removes it. It is a faithful reader of the API: a duplicate
 * term (case-insensitive) is refused there with a 409 the form surfaces, and the read/write split is
 * the API's (`doc.read` to search, `doc.write` to edit).
 *
 * ## What it does, and what it cannot
 *
 * - **Search filters by term prefix.** The query is passed to the API's `q`, which matches the start of
 *   the term; an empty box lists the whole glossary alphabetically.
 * - **A term is unique per studio.** A duplicate add or rename is a 409 the API returns; the form shows
 *   it rather than pretending the write succeeded.
 */
export function GlossaryScreen({
  organizationSlug,
  organizationName,
  client,
}: GlossaryScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [definition, setDefinition] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const queryKey = ['glossary', organizationSlug, search] as const;
  const terms = useQuery({
    queryKey,
    queryFn: () => listGlossaryTerms(api, organizationSlug, search.trim() || undefined),
  });

  function resetForm(): void {
    setTerm('');
    setDefinition('');
    setEditingId(null);
  }

  const save = useMutation({
    mutationFn: () =>
      editingId === null
        ? createGlossaryTerm(api, organizationSlug, { term, definition })
        : updateGlossaryTerm(api, organizationSlug, editingId, { term, definition }),
    onSuccess: async () => {
      setSaved(true);
      resetForm();
      await queryClient.invalidateQueries({ queryKey: ['glossary', organizationSlug] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteGlossaryTerm(api, organizationSlug, id),
    onSuccess: async () => {
      resetForm();
      await queryClient.invalidateQueries({ queryKey: ['glossary', organizationSlug] });
    },
  });

  function beginEdit(row: GlossaryTermSummary): void {
    setSaved(false);
    setEditingId(row.id);
    setTerm(row.term);
    setDefinition(row.definition);
  }

  const rows = terms.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Glossary"
      description="Your studio's shared vocabulary — the terms and what they mean here."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-glossary-heading">
        <h2 id="tm-glossary-heading" className="tm-eyebrow">
          Terms
        </h2>

        <Field
          label="Search"
          name="glossary-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          hint="Filter by the start of a term. Leave empty to see the whole glossary."
        />

        {terms.isError ? (
          <InlineAlert tone="danger" title="Could not load the glossary" live>
            {describeError(terms.error)}
          </InlineAlert>
        ) : null}

        {terms.isPending ? (
          <LoadingRegion label="Loading the glossary.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!terms.isPending && !terms.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No terms">
            {search.trim() === ''
              ? 'The glossary is empty. Add the first term below.'
              : 'No term starts with that. Try a different search.'}
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-stack" aria-label="Glossary terms">
            {rows.map((row) => (
              <li key={row.id} className="tm-row">
                <div className="tm-stack">
                  <strong>{row.term}</strong>
                  <span>{row.definition}</span>
                </div>
                <div className="tm-row">
                  <Button type="button" tone="text" size="compact" onClick={() => beginEdit(row)}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    tone="destructive"
                    size="compact"
                    loading={remove.isPending && remove.variables === row.id}
                    loadingLabel="Removing"
                    onClick={() => {
                      setSaved(false);
                      if (!remove.isPending) remove.mutate(row.id);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-glossary-form-heading">
        <h2 id="tm-glossary-form-heading" className="tm-eyebrow">
          {editingId === null ? 'Add a term' : 'Edit term'}
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label={editingId === null ? 'Add a glossary term' : 'Edit a glossary term'}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setSaved(false);
            if (!save.isPending && term.trim() !== '' && definition.trim() !== '') save.mutate();
          }}
        >
          <Field
            label="Term"
            name="glossary-term"
            value={term}
            required
            onChange={(event) => setTerm(event.target.value)}
            hint="A short name, unique within your studio."
          />
          <Field
            label="Definition"
            name="glossary-definition"
            value={definition}
            required
            onChange={(event) => setDefinition(event.target.value)}
            hint="What the term means here."
          />

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not save the term" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved" live>
              The glossary has been updated.
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel="Saving"
            >
              {editingId === null ? 'Add term' : 'Save changes'}
            </Button>
            {editingId !== null ? (
              <Button
                type="button"
                tone="outline"
                size="accessible"
                onClick={() => {
                  setSaved(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
