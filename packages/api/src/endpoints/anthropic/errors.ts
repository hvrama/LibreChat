import { Providers } from '@librechat/agents';
import { ErrorTypes } from 'librechat-data-provider';

/** Anthropic's status code for "the API is temporarily overloaded" */
const OVERLOADED_STATUS = 529;
const OVERLOADED_ERROR_TYPE = 'overloaded_error';

/**
 * The `@anthropic-ai/sdk` bakes the raw response body into the error message
 * (`529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`),
 * which is what reaches the chat verbatim when nothing maps it.
 */
const OVERLOADED_MESSAGE_REGEX = /overloaded_error|\b529\b.*overloaded/i;

type AnthropicErrorBody = {
  type?: unknown;
  error?: { type?: unknown } | null;
};

type AnthropicApiError = {
  status?: unknown;
  message?: unknown;
  error?: AnthropicErrorBody | null;
};

function toApiError(error: unknown): AnthropicApiError | undefined {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  return error as AnthropicApiError;
}

function hasOverloadedBody(body?: AnthropicErrorBody | null): boolean {
  if (body == null) {
    return false;
  }
  return body.type === OVERLOADED_ERROR_TYPE || body.error?.type === OVERLOADED_ERROR_TYPE;
}

/**
 * True when Anthropic rejected the request because its API is overloaded, whether the signal is
 * the SDK's typed `status`, the parsed response body, or only the message text a wrapper kept.
 */
export function isAnthropicOverloadedError(error: unknown): boolean {
  if (typeof error === 'string') {
    return OVERLOADED_MESSAGE_REGEX.test(error);
  }
  const apiError = toApiError(error);
  if (apiError == null) {
    return false;
  }
  if (apiError.status === OVERLOADED_STATUS || hasOverloadedBody(apiError.error)) {
    return true;
  }
  return typeof apiError.message === 'string' && OVERLOADED_MESSAGE_REGEX.test(apiError.message);
}

/**
 * Maps a failed Anthropic request to the typed error payload the client localizes, or
 * `undefined` to leave the original error alone. `info` carries the provider so the copy can
 * name it.
 */
export function resolveAnthropicApiError(params: {
  error: unknown;
  provider?: string;
}): string | undefined {
  if (params.provider !== Providers.ANTHROPIC) {
    return undefined;
  }
  if (!isAnthropicOverloadedError(params.error)) {
    return undefined;
  }
  return JSON.stringify({ type: ErrorTypes.PROVIDER_OVERLOADED, info: params.provider });
}
