import { scheduledPromptsConfigSchema } from 'librechat-data-provider';
import type { ScheduledPromptsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

const DEFAULT_CONFIG: ScheduledPromptsConfig = scheduledPromptsConfigSchema.parse({});

/** Resolves the scheduled prompts section with defaults applied; disabled when absent or invalid. */
export function resolveScheduledPromptsConfig(
  appConfig?: Pick<AppConfig, 'scheduledPrompts' | 'config'> | null,
): ScheduledPromptsConfig {
  const raw = appConfig?.scheduledPrompts ?? appConfig?.config?.scheduledPrompts;
  if (raw == null) {
    return DEFAULT_CONFIG;
  }
  const parsed = scheduledPromptsConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}
