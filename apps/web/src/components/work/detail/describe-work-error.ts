import { ApiRequestError, NetworkError } from '../../../lib/api/errors';

/**
 * A failed request on the work page in words: the API's own sentence for a refusal, the network
 * line when the request never arrived, and the general line for anything else. One rule for the
 * page body, the properties panel and the Files section, so the same failure reads the same.
 */
export function describeWorkError(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('WorkDetail.networkError');
  return t('WorkDetail.genericError');
}
