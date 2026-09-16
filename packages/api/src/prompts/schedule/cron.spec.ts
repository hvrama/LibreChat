import { PromptSchedulePreset } from 'librechat-data-provider';
import type { TPromptScheduleSource } from 'librechat-data-provider';
import {
  validateCron,
  getNextRunAt,
  getNextRuns,
  assertMinInterval,
  isValidTimezone,
  resolveCronFromSource,
  PromptScheduleCronError,
} from './cron';

const DAILY_FLOOR = 1440;

describe('cron helpers', () => {
  describe('resolveCronFromSource', () => {
    it('converts presets to cron expressions', () => {
      const cases: Array<[TPromptScheduleSource, string]> = [
        [{ kind: 'preset', preset: PromptSchedulePreset.daily, time: '09:00' }, '0 9 * * *'],
        [{ kind: 'preset', preset: PromptSchedulePreset.weekdays, time: '17:30' }, '30 17 * * 1-5'],
        [
          { kind: 'preset', preset: PromptSchedulePreset.weekly, time: '08:15', dayOfWeek: 1 },
          '15 8 * * 1',
        ],
        [
          { kind: 'preset', preset: PromptSchedulePreset.monthly, time: '06:00', dayOfMonth: 15 },
          '0 6 15 * *',
        ],
      ];
      for (const [source, expected] of cases) {
        expect(resolveCronFromSource(source, 'UTC')).toBe(expected);
      }
    });

    it('passes raw cron through after normalizing whitespace', () => {
      expect(resolveCronFromSource({ kind: 'cron', cron: '  0   9 * *   1-5 ' }, 'UTC')).toBe(
        '0 9 * * 1-5',
      );
    });

    it('rejects a weekly preset without a day of week', () => {
      expect(() =>
        resolveCronFromSource(
          { kind: 'preset', preset: PromptSchedulePreset.weekly, time: '09:00' },
          'UTC',
        ),
      ).toThrow(PromptScheduleCronError);
    });

    it('rejects a malformed time', () => {
      expect(() =>
        resolveCronFromSource(
          { kind: 'preset', preset: PromptSchedulePreset.daily, time: '9am' },
          'UTC',
        ),
      ).toThrow(PromptScheduleCronError);
    });
  });

  describe('validateCron', () => {
    it('rejects six-field expressions', () => {
      expect(() => validateCron('0 0 9 * * *', 'UTC')).toThrow(/exactly 5 fields/);
    });

    it('rejects invalid syntax', () => {
      expect(() => validateCron('0 25 * * *', 'UTC')).toThrow(PromptScheduleCronError);
    });

    it('rejects unknown timezones', () => {
      expect(() => validateCron('0 9 * * *', 'Mars/Olympus')).toThrow(/Unknown timezone/);
    });
  });

  describe('isValidTimezone', () => {
    it('accepts IANA names and rejects garbage', () => {
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Not/AZone')).toBe(false);
    });
  });

  describe('assertMinInterval', () => {
    const from = new Date('2026-01-05T00:00:00Z');

    it('accepts daily and weekday schedules at a daily floor', () => {
      expect(() => assertMinInterval('0 9 * * *', 'UTC', DAILY_FLOOR, from)).not.toThrow();
      expect(() => assertMinInterval('0 9 * * 1-5', 'UTC', DAILY_FLOOR, from)).not.toThrow();
      expect(() => assertMinInterval('0 6 1 * *', 'UTC', DAILY_FLOOR, from)).not.toThrow();
    });

    it('rejects sub-daily schedules at a daily floor', () => {
      expect(() => assertMinInterval('0 */6 * * *', 'UTC', DAILY_FLOOR, from)).toThrow(
        /more often than the allowed minimum/,
      );
      expect(() => assertMinInterval('*/30 * * * *', 'UTC', DAILY_FLOOR, from)).toThrow(
        PromptScheduleCronError,
      );
      expect(() => assertMinInterval('0 9,17 * * *', 'UTC', DAILY_FLOOR, from)).toThrow(
        PromptScheduleCronError,
      );
    });

    it('tolerates the shortened day across a DST transition', () => {
      const beforeSpringForward = new Date('2026-03-06T00:00:00Z');
      expect(() =>
        assertMinInterval('0 9 * * *', 'America/New_York', DAILY_FLOOR, beforeSpringForward),
      ).not.toThrow();
    });

    it('allows hourly schedules when the floor is lowered', () => {
      expect(() => assertMinInterval('0 * * * *', 'UTC', 60, from)).not.toThrow();
      expect(() => assertMinInterval('*/15 * * * *', 'UTC', 60, from)).toThrow(
        PromptScheduleCronError,
      );
    });
  });

  describe('getNextRunAt / getNextRuns', () => {
    it('computes the next firing in the requested timezone', () => {
      const from = new Date('2026-06-01T14:00:00Z');
      const next = getNextRunAt('0 9 * * *', 'America/New_York', from);
      expect(next?.toISOString()).toBe('2026-06-02T13:00:00.000Z');
    });

    it('returns consecutive firings', () => {
      const from = new Date('2026-06-01T00:00:00Z');
      const runs = getNextRuns('0 9 * * 1-5', 'UTC', 3, from);
      expect(runs.map((run) => run.toISOString())).toEqual([
        '2026-06-01T09:00:00.000Z',
        '2026-06-02T09:00:00.000Z',
        '2026-06-03T09:00:00.000Z',
      ]);
    });
  });
});
