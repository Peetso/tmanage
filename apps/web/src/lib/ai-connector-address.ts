import { apiBaseUrl } from './api/browser-client';

/**
 * The addresses an AI app is given to reach this TManage deployment (S12).
 *
 * The API serves the hosted MCP endpoint at `/mcp` and the OpenAPI fallback at `/openapi/ai.json`
 * (S13). Both live on the API origin, which is the web origin itself on a same-origin deployment,
 * so the page reads it after hydration rather than baking one host into the bundle.
 */

/** The hosted MCP endpoint of a TManage deployment: `<origin>/mcp`. */
export function connectorAddress(origin: string): string {
  return `${trimOrigin(origin)}/mcp`;
}

/** The OpenAPI 3.1 file for GPT Actions and plain function calling: `<origin>/openapi/ai.json`. */
export function openApiAddress(origin: string): string {
  return `${trimOrigin(origin)}/openapi/ai.json`;
}

/** The API origin assistants call. Same-origin deployments serve the API from the web origin. */
export function deploymentAddress(): string {
  let base = '';
  try {
    base = apiBaseUrl();
  } catch {
    base = '';
  }
  if (base !== '') return trimOrigin(base);
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}
