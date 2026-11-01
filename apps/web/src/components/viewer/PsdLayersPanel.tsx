'use client';

import { useState } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewPsd, PreviewPsdLayer } from '../../lib/api/file-preview';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { FormatIcon } from './format-icons';
import './format-stages.css';

/**
 * V-22 (`463:25305` EN, `463:25658` AR; phone `463:25565`): the Photoshop file's layers, as a
 * read-only list for the right rail's Layers tab (or the phone's Layers sheet). Top layer first,
 * groups open and close with their chevron, the eye shows whether a layer was visible when the
 * file was saved — it is not a switch (no layer toggling in R4). The canvas shows the flattened
 * preview through the shell's ImageStage; {@link PsdNotice} is the line above it.
 */

const BLEND_KEYS: Readonly<Record<string, MessageKey>> = {
  normal: 'ViewerFormats.psd.blend.normal',
  'pass through': 'ViewerFormats.psd.blend.passThrough',
  multiply: 'ViewerFormats.psd.blend.multiply',
  screen: 'ViewerFormats.psd.blend.screen',
  overlay: 'ViewerFormats.psd.blend.overlay',
  'soft light': 'ViewerFormats.psd.blend.softLight',
  'hard light': 'ViewerFormats.psd.blend.hardLight',
  darken: 'ViewerFormats.psd.blend.darken',
  lighten: 'ViewerFormats.psd.blend.lighten',
  'color dodge': 'ViewerFormats.psd.blend.colorDodge',
  'color burn': 'ViewerFormats.psd.blend.colorBurn',
  difference: 'ViewerFormats.psd.blend.difference',
  exclusion: 'ViewerFormats.psd.blend.exclusion',
  hue: 'ViewerFormats.psd.blend.hue',
  saturation: 'ViewerFormats.psd.blend.saturation',
  color: 'ViewerFormats.psd.blend.color',
  luminosity: 'ViewerFormats.psd.blend.luminosity',
};

export interface PsdLayersPanelProps {
  readonly psd: PreviewPsd;
}

/** The note above the PSD canvas: exact composite, or an approximate stack of the layers. */
export function PsdNotice({ approximate }: { readonly approximate: boolean }) {
  const t = useT();
  return (
    <InlineAlert tone={approximate ? 'warning' : 'neutral'} className="tm-format-notice">
      {t(approximate ? 'ViewerFormats.psd.noticeApproximate' : 'ViewerFormats.psd.noticeComposite')}
    </InlineAlert>
  );
}

function LayerRow({
  layer,
  depth,
  path,
  closed,
  onToggle,
}: {
  readonly layer: PreviewPsdLayer;
  readonly depth: number;
  readonly path: string;
  readonly closed: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
}) {
  const t = useT();
  const group = layer.kind === 'group';
  const open = group && !closed.has(path);
  const blend = BLEND_KEYS[layer.blendMode] ? t(BLEND_KEYS[layer.blendMode]!) : layer.blendMode;
  let detail: string;
  if (layer.kind === 'smart_object') detail = t('ViewerFormats.psd.kind.smartObject');
  else if (layer.kind === 'adjustment') detail = t('ViewerFormats.psd.kind.adjustment');
  else if (layer.kind === 'text') {
    detail = `${t('ViewerFormats.psd.kind.text')} · ${layer.opacity}%`;
  } else detail = `${blend} · ${layer.opacity}%`;
  const name = layer.name.trim() === '' ? t('ViewerFormats.psd.unnamed') : layer.name;

  return (
    <li
      className="tm-psd-layer"
      data-hidden={layer.visible ? undefined : 'true'}
      aria-label={`${name}, ${detail}, ${t(layer.visible ? 'ViewerFormats.psd.visible' : 'ViewerFormats.psd.hidden')}`}
    >
      <div className="tm-psd-layer__row" style={{ paddingInlineStart: `${depth * 20}px` }}>
        <span
          className="tm-psd-layer__eye"
          title={t(layer.visible ? 'ViewerFormats.psd.visible' : 'ViewerFormats.psd.hidden')}
        >
          <FormatIcon name={layer.visible ? 'eye' : 'eye-off'} />
        </span>
        {group ? (
          <button
            type="button"
            className="tm-psd-layer__toggle"
            aria-expanded={open}
            aria-label={t(open ? 'ViewerFormats.psd.collapse' : 'ViewerFormats.psd.expand').replace(
              '{name}',
              name,
            )}
            onClick={() => onToggle(path)}
          >
            <FormatIcon name="chevron" className={open ? undefined : 'tm-format-icon--closed'} />
          </button>
        ) : (
          <span className="tm-psd-layer__glyph">
            <FormatIcon name="file" />
          </span>
        )}
        <span className="tm-psd-layer__text" aria-hidden="true">
          <span className="tm-psd-layer__name" dir="auto">
            {name}
          </span>
          <span className="tm-psd-layer__detail">{detail}</span>
        </span>
      </div>
      {open && layer.children.length > 0 ? (
        <ul className="tm-psd-layers__list">
          {layer.children.map((nested, index) => (
            <LayerRow
              key={`${path}/${index}`}
              layer={nested}
              depth={depth + 1}
              path={`${path}/${index}`}
              closed={closed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PsdLayersPanel({ psd }: PsdLayersPanelProps) {
  const t = useT();
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const summary = t('ViewerFormats.psd.summary')
    .replace('{layers}', String(psd.layerCount))
    .replace('{groups}', String(psd.groupCount));

  return (
    <section className="tm-psd-layers" aria-label={t('ViewerFormats.psd.title')}>
      <header className="tm-psd-layers__head">
        <span>{summary}</span>
        {psd.width && psd.height ? (
          <span className="tm-format-chip" dir="ltr">
            {`${psd.width} × ${psd.height} px`}
          </span>
        ) : null}
      </header>
      {psd.layers.length === 0 ? (
        <p className="tm-psd-layers__empty">{t('ViewerFormats.psd.empty')}</p>
      ) : (
        <ul className="tm-psd-layers__list">
          {psd.layers.map((layer, index) => (
            <LayerRow
              key={String(index)}
              layer={layer}
              depth={0}
              path={String(index)}
              closed={closed}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
      <p className="tm-psd-layers__foot">{t('ViewerFormats.psd.footnote')}</p>
    </section>
  );
}
