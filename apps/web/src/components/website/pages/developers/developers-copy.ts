/**
 * 54-04 Developer portal — every visible string, keyed for the catalogs, with its English text.
 * The keys reach `en.json`/`ar.json` through the R45 L2 i18n fragment; until then `tOr` shows the
 * English given here. Facts on this page mirror the code: `tmanage_pat_` tokens
 * (personal-access-token.ts), OAuth 2.1 + PKCE scopes read/write/manage (mcp plan §4.2), the public
 * throttle 120/min and 2,000/h per address (throttle-policies.ts) and the webhook signature headers
 * (webhook-signing.ts).
 */
export const DEV_COPY = {
  eyebrow: 'DEVELOPERS',
  title: 'Build on the TManage API.',
  lede: 'Connect your tools with a token or OAuth, stay inside the rate limits, receive signed webhooks and look up every endpoint.',
  ctaReference: 'Open the API reference',
  ctaToken: 'Create a token',
  navLabel: 'Developer documentation',
  navOverview: 'Overview',
  navAuth: 'Authentication',
  navLimits: 'Rate limits',
  navWebhooks: 'Webhooks',
  navReference: 'API reference',
  authTitle: 'Authentication',
  authLede:
    'Every request acts as one member of one workspace. The API checks that member’s permissions on every call.',
  tokenTitle: 'API tokens',
  tokenBody:
    'Create a token in Settings, API tokens. Send it as Authorization: Bearer tmanage_pat_… A token reaches one workspace and can be revoked at any time.',
  oauthTitle: 'OAuth for apps',
  oauthBody:
    'Apps and AI assistants connect with OAuth 2.1 and PKCE. The member approves the scopes: read, write or manage. Billing is never included by default.',
  limitsTitle: 'Rate limits',
  limitsLede:
    'Over a limit, the API answers 429 Too Many Requests with a Retry-After header. Wait that many seconds, then try again.',
  limitPublic: 'Public routes',
  limitPublicValue: '120 a minute, 2,000 an hour per address',
  limitSignIn: 'Sign-in and token routes',
  limitSignInValue: 'Stricter, per address',
  limitOver: 'Over the limit',
  limitOverValue: '429 with Retry-After',
  webhooksTitle: 'Webhooks',
  webhooksLede:
    'Each delivery is signed. Check X-TManage-Signature (HMAC-SHA256 of timestamp and body) and refuse a timestamp more than 5 minutes off.',
  referenceTitle: 'API reference',
  referenceLede: 'Every endpoint of the contract, grouped by area.',
  searchLabel: 'Search endpoints',
  noResults: 'No endpoint matches your search.',
  parameters: 'Parameters',
  requestBody: 'Request body',
  responses: 'Responses',
  required: 'required',
  none: 'None',
  schemasTitle: 'Schemas',
} as const;

export type DevCopyKey = keyof typeof DEV_COPY;

/** The catalog key of a copy entry. */
export const devKey = (key: DevCopyKey): string => `DevelopersPage.${key}`;
