'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert } from '@tmanage/ui';
import {
  installTemplatePack,
  listTemplatePacks,
  type TemplatePackInstallResult,
  type TemplatePackView,
} from '../../lib/api/template-packs';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useEscape, type TOr } from './EditMilestoneDialog';
import './template-packs.css';

/** "3 project templates · 2 docs · 2 automations", with the singular for a count of one. */
export function packMeta(pack: TemplatePackView, tOr: TOr): string {
  const count = (n: number, one: string, oneEn: string, many: string, manyEn: string) =>
    (n === 1 ? tOr(one, oneEn) : tOr(many, manyEn)).replace('{n}', String(n));
  return [
    count(
      pack.templateNames.length,
      'TemplatePacks.templatesOne',
      '{n} project template',
      'TemplatePacks.templates',
      '{n} project templates',
    ),
    count(pack.docs.length, 'TemplatePacks.docsOne', '{n} doc', 'TemplatePacks.docs', '{n} docs'),
    count(
      pack.automations.length,
      'TemplatePacks.automationsOne',
      '{n} automation',
      'TemplatePacks.automations',
      '{n} automations',
    ),
  ].join(' · ');
}

function packName(pack: TemplatePackView, tOr: TOr): string {
  return tOr(`TemplatePacks.pack.${pack.key}.name`, pack.name);
}

export interface TemplatePacksGalleryProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
}

/**
 * **Template packs gallery** (54-22, Figma section "R40 L1-54-22-template-packs" on the Product
 * page): the built-in packs as cards (name, description, "3 project templates · 2 docs · 2
 * automations", Install pack / Installed), and an install confirm listing the templates the pack
 * adds. Installing refreshes the organization's template list. Authorization is the API's
 * (`project.manage`); a refusal is shown as the API's sentence.
 */
export function TemplatePacksGallery({ api, organizationSlug }: TemplatePacksGalleryProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<TemplatePackView | null>(null);
  const [done, setDone] = useState<TemplatePackInstallResult | null>(null);

  const packs = useQuery({
    queryKey: ['template-packs', organizationSlug],
    queryFn: () => listTemplatePacks(api, organizationSlug),
  });

  return (
    <section className="tm-card tm-prj-card tm-packs" aria-labelledby="tm-template-packs-heading">
      <div className="tm-packs__head">
        <h2 id="tm-template-packs-heading" className="tm-packs__title">
          {tOr('TemplatePacks.title', 'Template packs')}
        </h2>
        <p className="tm-packs__lede">
          {tOr(
            'TemplatePacks.lede',
            'Ready-made bundles of project templates, docs and automations. Installing a pack adds its templates to this workspace.',
          )}
        </p>
      </div>

      {packs.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('TemplatePacks.loadFailed', 'Packs did not load')}
          live
        >
          {describeError(packs.error)}
        </InlineAlert>
      ) : null}

      {done ? (
        <InlineAlert
          tone="neutral"
          title={tOr('TemplatePacks.installedTitle', 'Pack installed')}
          live
        >
          {tOr('TemplatePacks.installedBody', '{n} templates added to this workspace.').replace(
            '{n}',
            String(done.templatesCreated),
          )}
          {done.templatesSkipped > 0
            ? ` ${tOr('TemplatePacks.skippedBody', '{n} skipped because the name is already in use.').replace('{n}', String(done.templatesSkipped))}`
            : null}
        </InlineAlert>
      ) : null}

      <ul className="tm-packs__grid">
        {(packs.data ?? []).map((pack) => (
          <li
            key={pack.key}
            className={`tm-packs__card${pack.installed ? ' tm-packs__card--installed' : ''}`}
          >
            <h3 className="tm-packs__name">{packName(pack, tOr)}</h3>
            <p className="tm-packs__desc">
              {tOr(`TemplatePacks.pack.${pack.key}.description`, pack.description)}
            </p>
            <p className="tm-packs__meta">{packMeta(pack, tOr)}</p>
            <div className="tm-packs__action">
              {pack.installed ? (
                <Badge>{tOr('TemplatePacks.installed', 'Installed')}</Badge>
              ) : (
                <Button
                  type="button"
                  tone="outline"
                  onClick={() => {
                    setDone(null);
                    setConfirming(pack);
                  }}
                >
                  {tOr('TemplatePacks.install', 'Install pack')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {confirming ? (
        <InstallTemplatePackDialog
          api={api}
          organizationSlug={organizationSlug}
          pack={confirming}
          onClose={() => setConfirming(null)}
          onInstalled={async (result) => {
            setConfirming(null);
            setDone(result);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['template-packs', organizationSlug] }),
              queryClient.invalidateQueries({ queryKey: ['project-templates', organizationSlug] }),
            ]);
          }}
        />
      ) : null}
    </section>
  );
}

interface InstallTemplatePackDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly pack: TemplatePackView;
  readonly onClose: () => void;
  readonly onInstalled: (result: TemplatePackInstallResult) => void | Promise<void>;
}

/** The install confirm: the templates the pack adds, Cancel / Install pack. */
function InstallTemplatePackDialog({
  api,
  organizationSlug,
  pack,
  onClose,
  onInstalled,
}: InstallTemplatePackDialogProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const titleId = useId();
  useEscape(onClose);

  const install = useMutation({
    mutationFn: () => installTemplatePack(api, organizationSlug, pack.key),
    onSuccess: onInstalled,
  });

  return (
    <div className="tm-command-palette__backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-a9-dialog tm-a9-dialog--narrow"
      >
        <h2 id={titleId} className="tm-a9-dialog__title">
          {tOr('TemplatePacks.confirmTitle', 'Install “{name}”?').replace(
            '{name}',
            packName(pack, tOr),
          )}
        </h2>
        <p className="tm-a9-dialog__lede">
          {tOr(
            'TemplatePacks.confirmLede',
            'This adds the pack’s project templates to this workspace. The pack’s docs and automations are listed in each template’s description.',
          )}
        </p>
        <p className="tm-packs__list-label">
          {tOr('TemplatePacks.confirmList', 'Templates this pack adds')}
        </p>
        <ul className="tm-packs__list">
          {pack.templateNames.map((name) => (
            <li key={name} className="tm-packs__list-item" dir="auto">
              {name}
            </li>
          ))}
        </ul>
        <p className="tm-packs__note">
          {tOr('TemplatePacks.confirmNote', 'A template whose name is already in use is skipped.')}
        </p>
        {install.isError ? (
          <p className="tm-a9-error" role="alert">
            {describeError(install.error)}
          </p>
        ) : null}
        <div className="tm-a9-footer">
          <Button type="button" tone="text" onClick={onClose}>
            {tOr('TemplatePacks.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            tone="ink"
            loading={install.isPending}
            loadingLabel={tOr('TemplatePacks.installing', 'Installing…')}
            onClick={() => install.mutate()}
          >
            {tOr('TemplatePacks.install', 'Install pack')}
          </Button>
        </div>
      </div>
    </div>
  );
}
