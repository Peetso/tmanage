'use client';

import { useCallback } from 'react';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { fill } from './assistant-sites';

/** Every string the AI panel draws, in the `AiPanel.*` namespace of the catalogs. */
export type AiPanelKey = Extract<MessageKey, `AiPanel.${string}`>;

/** `t` for the panel's keys, with `{name}`-style values filled in. */
export function useAiPanelT(): (
  key: AiPanelKey,
  values?: Readonly<Record<string, string>>,
) => string {
  const t = useT();
  return useCallback(
    (key, values) => {
      const template = t(key as MessageKey);
      return values ? fill(template, values) : template;
    },
    [t],
  );
}
