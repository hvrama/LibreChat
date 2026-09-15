import { resolveAnthropicApiError } from './anthropic/errors';
import { resolveGoogleVideoError } from './google/errors';

export type ProviderErrorContext = {
  error: unknown;
  provider?: string;
  hasYouTubeVideo?: boolean;
};

const resolvers: Array<(context: ProviderErrorContext) => string | undefined> = [
  resolveAnthropicApiError,
  resolveGoogleVideoError,
];

/**
 * Maps a failed provider request to the typed error payload the client localizes, trying each
 * provider-specific resolver in turn; `undefined` leaves the original error to the generic copy.
 */
export function resolveProviderError(context: ProviderErrorContext): string | undefined {
  for (const resolve of resolvers) {
    const mapped = resolve(context);
    if (mapped != null) {
      return mapped;
    }
  }
  return undefined;
}
