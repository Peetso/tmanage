import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

/** The brand mark on the ink background, served by the web app from `apps/web/public/brand/`. */
export const SERVER_ICON_PATHS = {
  png: '/brand/tmanage-icon-512.png',
  svg: '/brand/tmanage-maskable.svg',
} as const;

/**
 * The `initialize` result's `serverInfo` (MCP `Implementation`): name and version, plus the
 * display `title`, `websiteUrl` and `icons` a client such as Claude shows on the connector.
 *
 * `siteUrl` is the public web origin that serves the icon files. Without one only the name,
 * title and version are sent: an icon URL that does not resolve is worse than none.
 */
export function serverIdentity(name: string, version: string, siteUrl?: string): Implementation {
  const identity: Implementation = { name, version, title: 'TManage' };
  const origin = publicOrigin(siteUrl);
  if (origin === undefined) return identity;
  return {
    ...identity,
    websiteUrl: `${origin}/`,
    icons: [
      { src: `${origin}${SERVER_ICON_PATHS.png}`, mimeType: 'image/png', sizes: ['512x512'] },
      { src: `${origin}${SERVER_ICON_PATHS.svg}`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  };
}

/** The `https:`/`http:` origin of a URL, or undefined when there is none to use. */
function publicOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
