'use client';

import { useEffect } from 'react';
import { BETA_INCLUDED } from './pages/pricing/pricing-data';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { localizeHref } from '../../lib/i18n/public-locale-routes';
import { useRouteLocale } from '../../lib/i18n/route-locale';
import { PUBLIC_PAGES } from '../../lib/public-pages';
import { SIGN_UP_HREF } from '../../lib/public-signup';

/**
 * WebMCP (AGENTREADY, 2026-11-16): a few read-only tools an AI agent in the visitor's browser can
 * call on the public website, registered through `navigator.modelContext` where the browser has
 * it and skipped where it does not. None of them reads or changes an account, and none sends
 * anything anywhere: two answer from the page data already in this bundle, and `open_sign_up`
 * only opens the sign-up page in this tab, as the visitor's own click would.
 */

interface WebMcpTextContent {
  readonly type: 'text';
  readonly text: string;
}

interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, never> };
  readonly annotations: { readonly readOnlyHint: boolean };
  readonly execute: () => Promise<{ readonly content: readonly WebMcpTextContent[] }>;
}

interface ModelContext {
  registerTool(tool: WebMcpTool): unknown;
  unregisterTool?(name: string): void;
}

function modelContext(): ModelContext | undefined {
  const candidate: unknown = (navigator as Navigator & { modelContext?: unknown }).modelContext;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return typeof (candidate as Partial<ModelContext>).registerTool === 'function'
    ? (candidate as ModelContext)
    : undefined;
}

/** The handle some drafts of the API return from `registerTool`. */
function hasUnregister(value: unknown): value is { unregister(): void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { unregister?: unknown }).unregister === 'function'
  );
}

const NO_INPUT = { type: 'object', properties: {} } as const;

function text(value: string): Promise<{ content: readonly WebMcpTextContent[] }> {
  return Promise.resolve({ content: [{ type: 'text', text: value }] });
}

export function WebMcpTools() {
  const t = useT();
  const arabic = useRouteLocale() !== undefined;

  useEffect(() => {
    const context = modelContext();
    if (context === undefined) return undefined;
    const here = (path: string): string => (arabic ? localizeHref(path) : path);
    const tools: WebMcpTool[] = [
      {
        name: 'get_pricing_summary',
        description: 'What TManage costs and what is included during the public beta.',
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
        execute: () =>
          text(
            [
              t('PricingPage.betaCardTitle'),
              t('PricingPage.betaCardBody'),
              ...BETA_INCLUDED.map((key) => `- ${t(key as MessageKey)}`),
              `${t('PricingPage.betaAfterLabel')} ${t('PricingPage.betaAfterBody')}`,
            ].join('\n'),
          ),
      },
      {
        name: 'list_features',
        description: 'The TManage product and feature pages, with their addresses.',
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
        execute: () =>
          text(
            PUBLIC_PAGES.filter((page) => page.section === 'product')
              .map((page) => `- ${page.title}: ${here(page.path)}`)
              .join('\n'),
          ),
      },
      {
        name: 'open_sign_up',
        description: 'Open the TManage sign-up page in this tab. Creates nothing.',
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
        execute: () => {
          window.location.assign(here(SIGN_UP_HREF));
          return text(`Opened ${here(SIGN_UP_HREF)}`);
        },
      },
    ];
    // A browser that refuses one tool (a name it already holds) keeps the others.
    const registered = tools.flatMap((tool) => {
      try {
        return [{ tool, handle: context.registerTool(tool) }];
      } catch {
        return [];
      }
    });
    return () => {
      for (const { tool, handle } of registered) {
        if (hasUnregister(handle)) handle.unregister();
        else context.unregisterTool?.(tool.name);
      }
    };
  }, [arabic, t]);

  return null;
}
