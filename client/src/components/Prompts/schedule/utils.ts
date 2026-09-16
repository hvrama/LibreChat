import { PromptSchedulePreset, specialVariables } from 'librechat-data-provider';
import type { TPromptScheduleSource, TPromptGroupScheduleInput } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { extractUniqueVariables } from '~/utils';

export type ScheduleFrequency = PromptSchedulePreset | 'custom';

export type ScheduleFormState = {
  agentId: string;
  frequency: ScheduleFrequency;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  cron: string;
  timezone: string;
  variables: Record<string, string>;
  notifyEmail: boolean;
};

export type ScheduleFormErrors = Partial<Record<'agentId' | 'time' | 'cron', TranslationKeys>>;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const CRON_FIELD_COUNT = 5;

export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function listTimezones(...ensure: string[]): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const set = new Set(['UTC', ...zones, ...ensure.filter(Boolean)]);
  return [...set];
}

/** Variables the user must supply for a scheduled run (special ones are auto-filled). */
export function getUserVariables(promptText: string): string[] {
  return extractUniqueVariables(promptText)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !specialVariables[name.toLowerCase()]);
}

export function toFormState(
  source: TPromptScheduleSource | undefined,
  base: Omit<ScheduleFormState, 'frequency' | 'time' | 'dayOfWeek' | 'dayOfMonth' | 'cron'>,
): ScheduleFormState {
  const defaults = { frequency: PromptSchedulePreset.daily as ScheduleFrequency, time: '09:00' };
  const state: ScheduleFormState = { ...base, ...defaults, dayOfWeek: 1, dayOfMonth: 1, cron: '' };
  if (!source) {
    return state;
  }
  if (source.kind === 'cron') {
    return { ...state, frequency: 'custom', cron: source.cron };
  }
  return {
    ...state,
    frequency: source.preset,
    time: source.time,
    dayOfWeek: source.dayOfWeek ?? 1,
    dayOfMonth: source.dayOfMonth ?? 1,
  };
}

export function validateFormState(state: ScheduleFormState): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  if (!state.agentId) {
    errors.agentId = 'com_ui_schedule_agent_required';
  }
  if (state.frequency === 'custom') {
    if (state.cron.trim().split(/\s+/).length !== CRON_FIELD_COUNT) {
      errors.cron = 'com_ui_schedule_cron_invalid';
    }
  } else if (!TIME_PATTERN.test(state.time)) {
    errors.time = 'com_ui_schedule_time_invalid';
  }
  return errors;
}

export function toScheduleInput(state: ScheduleFormState): TPromptGroupScheduleInput {
  const source: TPromptScheduleSource =
    state.frequency === 'custom'
      ? { kind: 'cron', cron: state.cron.trim() }
      : {
          kind: 'preset',
          preset: state.frequency,
          time: state.time,
          ...(state.frequency === PromptSchedulePreset.weekly && { dayOfWeek: state.dayOfWeek }),
          ...(state.frequency === PromptSchedulePreset.monthly && {
            dayOfMonth: state.dayOfMonth,
          }),
        };
  return {
    agent_id: state.agentId,
    source,
    timezone: state.timezone,
    variables: state.variables,
    notify: { email: state.notifyEmail },
  };
}

export function getResponseError(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } })?.response
    ?.data;
  const message = data?.error ?? data?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

export function isConflictError(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}
