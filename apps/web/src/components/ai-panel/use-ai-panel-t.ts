'use client';

import { useCallback } from 'react';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { fill } from './assistant-sites';

/** Every string the AI panel draws, in the `AiPanel.*` namespace of the catalogs. */
export type AiPanelKey =
  | 'AiPanel.launch'
  | 'AiPanel.panelLabel'
  | 'AiPanel.chooserTitle'
  | 'AiPanel.chooserHint'
  | 'AiPanel.connectedByUsed'
  | 'AiPanel.connectedByUnused'
  | 'AiPanel.alwaysOpen'
  | 'AiPanel.connectedApps'
  | 'AiPanel.emptyTitle'
  | 'AiPanel.emptyBody'
  | 'AiPanel.copy'
  | 'AiPanel.copied'
  | 'AiPanel.notNow'
  | 'AiPanel.openConnectedApps'
  | 'AiPanel.windowTitle'
  | 'AiPanel.windowBody'
  | 'AiPanel.windowPopups'
  | 'AiPanel.open'
  | 'AiPanel.switch'
  | 'AiPanel.popOut'
  | 'AiPanel.close'
  | 'AiPanel.resize'
  | 'AiPanel.trust'
  | 'AiPanel.siteTitle'
  | 'AiPanel.siteBody'
  | 'AiPanel.signInTitle'
  | 'AiPanel.signInBody'
  | 'AiPanel.nextTitle'
  | 'AiPanel.missingTitle'
  | 'AiPanel.addConnector'
  | 'AiPanel.connectorAddress'
  | 'AiPanel.checkAgain'
  | 'AiPanel.statusConnected'
  | 'AiPanel.statusSignIn'
  | 'AiPanel.statusMissing';

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
