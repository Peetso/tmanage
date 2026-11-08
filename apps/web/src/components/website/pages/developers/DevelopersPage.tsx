'use client';

import { Badge } from '@tmanage/ui';
import { useId, useMemo, useState } from 'react';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { ButtonLink } from '../../primitives';
import {
  filterGroups,
  type ApiOperation,
  type ApiReference,
  type ApiSchema,
} from './api-reference';
import { DEV_COPY, devKey, type DevCopyKey } from './developers-copy';
import './developers.css';

const SECTIONS = [
  { id: 'overview', nav: 'navOverview' },
  { id: 'authentication', nav: 'navAuth' },
  { id: 'rate-limits', nav: 'navLimits' },
  { id: 'webhooks', nav: 'navWebhooks' },
  { id: 'reference', nav: 'navReference' },
] as const satisfies readonly { id: string; nav: DevCopyKey }[];

function useCopy(): (key: DevCopyKey) => string {
  const tOr = useTOr();
  return (key) => tOr(devKey(key), DEV_COPY[key]);
}

/**
 * 54-04 Developer portal (`/developers`, Arabic twin `/ar/developers`), built to Figma 584:33074
 * (EN) / 584:33266 (AR): a side nav, then overview, authentication, rate limits, webhooks and the
 * API reference generated at build time from the product contract, with search. Layout uses
 * logical properties, so the Arabic page mirrors without its own rules.
 */
export function DevelopersPage({ reference }: { reference: ApiReference }) {
  const c = useCopy();
  return (
    <div className="tm-web-dev tm-web-container">
      <nav className="tm-web-dev__nav" aria-label={c('navLabel')}>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{c(s.nav)}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="tm-web-dev__main">
        <section id="overview" className="tm-web-dev__hero" aria-labelledby="dev-title">
          <Badge tone="neutral">{c('eyebrow')}</Badge>
          <h1 id="dev-title" className="tm-web-dev__title">
            {c('title')}
          </h1>
          <p className="tm-web-dev__lede tm-web-dev__lede--lg">{c('lede')}</p>
          <div className="tm-web-dev__actions">
            <ButtonLink href="#reference" tone="lime" size="default">
              {c('ctaReference')}
            </ButtonLink>
            <ButtonLink href={SIGN_UP_HREF} tone="outline" size="default">
              {c('ctaToken')}
            </ButtonLink>
          </div>
        </section>

        <DocSection id="authentication" title={c('authTitle')} lede={c('authLede')}>
          <div className="tm-web-dev__cards">
            <article className="tm-web-dev__card">
              <h3>{c('tokenTitle')}</h3>
              <p>{c('tokenBody')}</p>
            </article>
            <article className="tm-web-dev__card">
              <h3>{c('oauthTitle')}</h3>
              <p>{c('oauthBody')}</p>
            </article>
          </div>
        </DocSection>

        <DocSection id="rate-limits" title={c('limitsTitle')} lede={c('limitsLede')}>
          <dl className="tm-web-dev__card tm-web-dev__limits">
            {(
              [
                ['limitPublic', 'limitPublicValue'],
                ['limitSignIn', 'limitSignInValue'],
                ['limitOver', 'limitOverValue'],
              ] as const
            ).map(([term, value]) => (
              <div key={term} className="tm-web-dev__limit">
                <dt>{c(term)}</dt>
                <dd>{c(value)}</dd>
              </div>
            ))}
          </dl>
        </DocSection>

        <DocSection id="webhooks" title={c('webhooksTitle')} lede={c('webhooksLede')}>
          <pre className="tm-web-dev__code" dir="ltr">
            {[
              'X-TManage-Timestamp: 1767225600',
              'X-TManage-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>',
              'X-TManage-Event: work_item.created',
            ].join('\n')}
          </pre>
        </DocSection>

        <DocSection id="reference" title={c('referenceTitle')} lede={c('referenceLede')}>
          <ReferenceExplorer reference={reference} />
        </DocSection>
      </div>
    </div>
  );
}

function DocSection({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="tm-web-dev__section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="tm-web-dev__h2">
        {title}
      </h2>
      <p className="tm-web-dev__lede">{lede}</p>
      {children}
    </section>
  );
}

/** The searchable reference: tag groups of operations, each expandable to params and responses. */
export function ReferenceExplorer({ reference }: { reference: ApiReference }) {
  const c = useCopy();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => filterGroups(reference.groups, query), [reference.groups, query]);
  const schemas = useMemo(
    () => new Map(reference.schemas.map((s) => [s.name, s] as const)),
    [reference.schemas],
  );
  return (
    <div className="tm-web-dev__reference">
      <label htmlFor={searchId} className="tm-web-dev__sr">
        {c('searchLabel')}
      </label>
      <input
        id={searchId}
        type="search"
        className="tm-web-dev__search"
        placeholder={c('searchLabel')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.length === 0 ? (
        <p className="tm-web-dev__lede" role="status">
          {c('noResults')}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.tag} className="tm-web-dev__card tm-web-dev__group">
            <h3>{group.tag}</h3>
            <ul>
              {group.operations.map((op) => (
                <li key={`${op.method} ${op.path}`}>
                  <OperationRow op={op} schemas={schemas} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function OperationRow({
  op,
  schemas,
}: {
  op: ApiOperation;
  schemas: ReadonlyMap<string, ApiSchema>;
}) {
  const c = useCopy();
  const shown = [op.requestSchema, ...op.responses.map((r) => r.schema)]
    .map((name) => (name ?? '').replace(/\[\]$/, ''))
    .filter((name, i, all) => schemas.has(name) && all.indexOf(name) === i)
    .map((name) => schemas.get(name)!)
    .filter((schema) => schema.fields.length > 0);
  return (
    <details className="tm-web-dev__op">
      <summary>
        <Badge tone="neutral" mono>
          {op.method.toUpperCase()}
        </Badge>
        <code dir="ltr">{op.path}</code>
        <span className="tm-web-dev__op-id">{op.id}</span>
      </summary>
      <div className="tm-web-dev__op-detail">
        <div className="tm-web-dev__panel">
          <h4>{c('parameters')}</h4>
          {op.params.length === 0 ? (
            <p>{c('none')}</p>
          ) : (
            <ul dir="ltr">
              {op.params.map((p) => (
                <li key={`${p.in}:${p.name}`}>
                  <code>
                    {p.name} · {p.in} · {p.type}
                    {p.required ? ` · ${c('required')}` : ''}
                  </code>
                </li>
              ))}
            </ul>
          )}
          {op.requestSchema !== null ? (
            <>
              <h4>{c('requestBody')}</h4>
              <code dir="ltr">{op.requestSchema}</code>
            </>
          ) : null}
        </div>
        <div className="tm-web-dev__panel">
          <h4>{c('responses')}</h4>
          <ul dir="ltr">
            {op.responses.map((r) => (
              <li key={r.status}>
                <code>
                  {r.status}
                  {r.schema !== null ? ` · ${r.schema}` : ''}
                </code>{' '}
                <span>{r.description}</span>
              </li>
            ))}
          </ul>
        </div>
        {shown.length > 0 ? (
          <div className="tm-web-dev__panel tm-web-dev__panel--wide">
            <h4>{c('schemasTitle')}</h4>
            {shown.map((schema) => (
              <dl key={schema.name} dir="ltr" className="tm-web-dev__schema">
                <dt>
                  <code>{schema.name}</code>
                </dt>
                {schema.fields.map((f) => (
                  <dd key={f.name}>
                    <code>
                      {f.name}: {f.type}
                      {f.required ? ` · ${c('required')}` : ''}
                    </code>
                  </dd>
                ))}
              </dl>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
