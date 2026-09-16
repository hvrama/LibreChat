import { PromptSchedulePreset } from './types';
import type { TPromptScheduleSource, TPromptSchedulePresetSource } from './types';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class PromptScheduleSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptScheduleSourceError';
  }
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(time);
  if (!match) {
    throw new PromptScheduleSourceError('time must be in HH:mm (24h) format');
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertInt(value: number | undefined, min: number, max: number, label: string): number {
  if (value == null || !Number.isInteger(value) || value < min || value > max) {
    throw new PromptScheduleSourceError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Converts a friendly preset into a 5-field cron expression. */
export function presetToCron(source: TPromptSchedulePresetSource): string {
  const { hour, minute } = parseTime(source.time);
  switch (source.preset) {
    case PromptSchedulePreset.daily:
      return `${minute} ${hour} * * *`;
    case PromptSchedulePreset.weekdays:
      return `${minute} ${hour} * * 1-5`;
    case PromptSchedulePreset.weekly: {
      const dayOfWeek = assertInt(source.dayOfWeek, 0, 6, 'dayOfWeek');
      return `${minute} ${hour} * * ${dayOfWeek}`;
    }
    case PromptSchedulePreset.monthly: {
      const dayOfMonth = assertInt(source.dayOfMonth, 1, 31, 'dayOfMonth');
      return `${minute} ${hour} ${dayOfMonth} * *`;
    }
    default:
      throw new PromptScheduleSourceError(`Unknown preset "${String(source.preset)}"`);
  }
}

/** Resolves any schedule source to its cron expression (raw cron passes through trimmed). */
export function scheduleSourceToCron(source: TPromptScheduleSource): string {
  if (source.kind === 'cron') {
    const cron = source.cron?.trim();
    if (!cron) {
      throw new PromptScheduleSourceError('cron expression is required');
    }
    return cron;
  }
  return presetToCron(source);
}
