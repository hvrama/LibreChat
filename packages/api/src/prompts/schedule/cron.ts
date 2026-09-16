import { Cron } from 'croner';
import { scheduleSourceToCron, PromptScheduleSourceError } from 'librechat-data-provider';
import type { TPromptScheduleSource } from 'librechat-data-provider';

const CRON_FIELD_COUNT = 5;
const OCCURRENCES_TO_CHECK = 6;
const MINUTE_MS = 60_000;
/** Daylight-saving transitions shrink one daily gap by up to an hour. */
const DST_TOLERANCE_MINUTES = 60;

export class PromptScheduleCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptScheduleCronError';
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function parseCron(expression: string, timezone: string): Cron {
  try {
    return new Cron(expression, { timezone });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PromptScheduleCronError(`Invalid cron expression: ${reason}`);
  }
}

/** Validates a 5-field cron expression for the given timezone and returns it normalized. */
export function validateCron(expression: string, timezone: string): string {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  if (normalized.split(' ').length !== CRON_FIELD_COUNT) {
    throw new PromptScheduleCronError(
      'Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)',
    );
  }
  if (!isValidTimezone(timezone)) {
    throw new PromptScheduleCronError(`Unknown timezone "${timezone}"`);
  }
  const cron = parseCron(normalized, timezone);
  if (!cron.nextRun()) {
    throw new PromptScheduleCronError('Cron expression never fires');
  }
  return normalized;
}

export function getNextRunAt(expression: string, timezone: string, from?: Date): Date | null {
  return parseCron(expression, timezone).nextRun(from ?? new Date());
}

export function getNextRuns(
  expression: string,
  timezone: string,
  count: number,
  from?: Date,
): Date[] {
  return parseCron(expression, timezone).nextRuns(count, from ?? new Date());
}

/**
 * Rejects expressions whose consecutive firings can be closer than the configured floor.
 * Inspects several upcoming occurrences so step patterns like `*\/30 * * * *` are caught.
 */
export function assertMinInterval(
  expression: string,
  timezone: string,
  minIntervalMinutes: number,
  from?: Date,
): void {
  if (minIntervalMinutes <= 1) {
    return;
  }
  const runs = getNextRuns(expression, timezone, OCCURRENCES_TO_CHECK, from);
  const tolerance = minIntervalMinutes > DST_TOLERANCE_MINUTES ? DST_TOLERANCE_MINUTES : 0;
  const floorMs = (minIntervalMinutes - tolerance) * MINUTE_MS;
  for (let i = 1; i < runs.length; i++) {
    const gap = runs[i].getTime() - runs[i - 1].getTime();
    if (gap < floorMs) {
      throw new PromptScheduleCronError(
        `Schedule fires more often than the allowed minimum of ${minIntervalMinutes} minutes`,
      );
    }
  }
}

/** Converts any schedule source to a validated cron expression. */
export function resolveCronFromSource(source: TPromptScheduleSource, timezone: string): string {
  try {
    return validateCron(scheduleSourceToCron(source), timezone);
  } catch (error) {
    if (error instanceof PromptScheduleSourceError) {
      throw new PromptScheduleCronError(error.message);
    }
    throw error;
  }
}
