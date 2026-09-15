import { Providers } from '@librechat/agents';
import { ErrorTypes } from 'librechat-data-provider';
import { isAnthropicOverloadedError, resolveAnthropicApiError } from './errors';

const OVERLOADED_BODY = {
  type: 'error',
  error: { type: 'overloaded_error', message: 'Overloaded' },
};

/** Verbatim message the `@anthropic-ai/sdk` raises for an HTTP 529. */
const SDK_MESSAGE = `529 ${JSON.stringify(OVERLOADED_BODY)}`;

function sdkError(status: number, body: object): Error & { status: number; error: object } {
  const error = new Error(`${status} ${JSON.stringify(body)}`) as Error & {
    status: number;
    error: object;
  };
  error.status = status;
  error.error = body;
  return error;
}

const EXPECTED = JSON.stringify({
  type: ErrorTypes.PROVIDER_OVERLOADED,
  info: Providers.ANTHROPIC,
});

describe('isAnthropicOverloadedError', () => {
  it('matches the SDK error for an HTTP 529', () => {
    expect(isAnthropicOverloadedError(sdkError(529, OVERLOADED_BODY))).toBe(true);
  });

  it('matches on the response body when the status is missing', () => {
    expect(isAnthropicOverloadedError({ error: OVERLOADED_BODY })).toBe(true);
    expect(isAnthropicOverloadedError({ error: OVERLOADED_BODY.error })).toBe(true);
  });

  it('matches when only the message text survived a wrapper', () => {
    expect(isAnthropicOverloadedError(new Error(SDK_MESSAGE))).toBe(true);
    expect(isAnthropicOverloadedError(SDK_MESSAGE)).toBe(true);
  });

  it('rejects rate limit, server, and request errors', () => {
    expect(
      isAnthropicOverloadedError(
        sdkError(429, {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limited' },
        }),
      ),
    ).toBe(false);
    expect(
      isAnthropicOverloadedError(
        sdkError(500, { type: 'error', error: { type: 'api_error', message: 'Internal error' } }),
      ),
    ).toBe(false);
    expect(
      isAnthropicOverloadedError(
        sdkError(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'max_tokens: 529 is too low' },
        }),
      ),
    ).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isAnthropicOverloadedError(undefined)).toBe(false);
    expect(isAnthropicOverloadedError(null)).toBe(false);
    expect(isAnthropicOverloadedError(529)).toBe(false);
  });
});

describe('resolveAnthropicApiError', () => {
  it('returns the typed payload for an overloaded Anthropic request', () => {
    expect(
      resolveAnthropicApiError({
        error: sdkError(529, OVERLOADED_BODY),
        provider: Providers.ANTHROPIC,
      }),
    ).toBe(EXPECTED);
  });

  it('leaves other Anthropic errors alone', () => {
    expect(
      resolveAnthropicApiError({
        error: sdkError(429, { type: 'error', error: { type: 'rate_limit_error' } }),
        provider: Providers.ANTHROPIC,
      }),
    ).toBeUndefined();
  });

  it('leaves other providers alone even with a matching shape', () => {
    expect(
      resolveAnthropicApiError({
        error: sdkError(529, OVERLOADED_BODY),
        provider: Providers.OPENAI,
      }),
    ).toBeUndefined();
    expect(resolveAnthropicApiError({ error: sdkError(529, OVERLOADED_BODY) })).toBeUndefined();
  });
});
