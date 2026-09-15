import { Providers } from '@librechat/agents';
import { ErrorTypes } from 'librechat-data-provider';
import { resolveProviderError } from './errors';

const OVERLOADED = Object.assign(new Error('529 {"type":"error"}'), { status: 529 });
const INVALID_ARGUMENT = Object.assign(new Error('Request contains an invalid argument.'), {
  status: 400,
});

describe('resolveProviderError', () => {
  it('maps an overloaded Anthropic request', () => {
    expect(resolveProviderError({ error: OVERLOADED, provider: Providers.ANTHROPIC })).toBe(
      JSON.stringify({ type: ErrorTypes.ANTHROPIC_OVERLOADED }),
    );
  });

  it('maps a Google video rejection', () => {
    expect(
      resolveProviderError({
        error: INVALID_ARGUMENT,
        provider: Providers.GOOGLE,
        hasYouTubeVideo: true,
      }),
    ).toBe(JSON.stringify({ type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE }));
  });

  it('returns undefined when no resolver claims the error', () => {
    expect(resolveProviderError({ error: OVERLOADED, provider: Providers.OPENAI })).toBeUndefined();
    expect(resolveProviderError({ error: new Error('boom') })).toBeUndefined();
  });
});
