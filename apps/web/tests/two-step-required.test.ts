import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { twoStepEnrolmentPath } from '../src/lib/api/browser-client';

/**
 * A11 — a company that requires two-step sign-in answers 403 `two_step_required` to a person who
 * has not enrolled; the web client recognises the code and sends them to the enrolment screen.
 */

function clientAnswering(status: number, code: string) {
  const onTwoStepRequired = vi.fn();
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'csrf',
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code, message: 'x', correlationId: 'c' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
    onTwoStepRequired,
  });
  return { client, onTwoStepRequired };
}

describe('two_step_required', () => {
  it('is parsed as its own code and reported to the application, and still thrown', async () => {
    const { client, onTwoStepRequired } = clientAnswering(403, 'two_step_required');
    const error = await client
      .request({ path: '/v1/organizations/harbour/projects' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe('two_step_required');
    expect(onTwoStepRequired).toHaveBeenCalledWith('/v1/organizations/harbour/projects');
  });

  it('is not reported for an ordinary forbidden', async () => {
    const { client, onTwoStepRequired } = clientAnswering(403, 'forbidden');
    await expect(client.request({ path: '/v1/organizations/harbour/projects' })).rejects.toThrow();
    expect(onTwoStepRequired).not.toHaveBeenCalled();
  });

  it("sends the person to that company's enrolment screen, never in a loop or off-site", () => {
    expect(twoStepEnrolmentPath('/v1/organizations/harbour/projects', '/harbour/home')).toBe(
      '/harbour/settings/two-step?required=1',
    );
    expect(
      twoStepEnrolmentPath('/v1/organizations/harbour/projects', '/harbour/settings/two-step'),
    ).toBeUndefined();
    expect(twoStepEnrolmentPath('/v1/auth/factors', '/harbour/home')).toBeUndefined();
    expect(twoStepEnrolmentPath('/v1/organizations/\\evil.example/x', '/')).toBeUndefined();
  });
});
