import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { ScheduledPromptsConfig } from 'librechat-data-provider';
import type { IPromptGroup } from '@librechat/data-schemas';
import { registerShutdownTask } from '~/app/shutdown';

const MINUTE_MS = 60_000;
const MIN_LEASE_REFRESH_MS = MINUTE_MS;
const JITTER_RATIO = 0.1;

type MaybePromise<T> = T | Promise<T>;

export type PromptScheduleRunContext = {
  lockOwner: string;
  leaseMs: number;
  signal: AbortSignal;
  trigger: 'schedule';
};

export type ClaimDueSchedulesInput = {
  now: Date;
  lockOwner: string;
  leaseMs: number;
  limit: number;
};

export type RefreshScheduleLockInput = {
  _id: string;
  lockOwner: string;
  leaseMs: number;
};

export type PromptSchedulerDeps = {
  getConfig: () => MaybePromise<ScheduledPromptsConfig | undefined>;
  claimDue: (input: ClaimDueSchedulesInput) => Promise<IPromptGroup[]>;
  refreshLock: (input: RefreshScheduleLockInput) => Promise<boolean>;
  execute: (schedule: IPromptGroup, context: PromptScheduleRunContext) => Promise<void>;
  /** Overrides the generated lock owner id (tests). */
  lockOwner?: string;
  /** Skips shutdown-task registration (tests). */
  registerShutdown?: boolean;
};

export type PromptScheduler = {
  readonly lockOwner: string;
  /** Claims and starts every due schedule once, without scheduling the next poll. */
  runOnce: () => Promise<number>;
  /** Stops polling and waits for in-flight runs to settle. */
  stop: () => Promise<void>;
  inFlightCount: () => number;
};

export function createLockOwner(prefix = 'prompt-scheduler'): string {
  return `${prefix}:${hostname()}:${process.pid}:${randomUUID()}`;
}

function withJitter(ms: number): number {
  const spread = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
}

export function startPromptScheduler(deps: PromptSchedulerDeps): PromptScheduler {
  const lockOwner = deps.lockOwner ?? createLockOwner();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let ticking = false;
  let timer: NodeJS.Timeout | undefined;

  const getConfig = async (): Promise<ScheduledPromptsConfig | undefined> => {
    try {
      return await deps.getConfig();
    } catch (error) {
      logger.error('[PromptScheduler] Failed to load config:', error);
      return undefined;
    }
  };

  const runSchedule = async (
    schedule: IPromptGroup,
    config: ScheduledPromptsConfig,
  ): Promise<void> => {
    const scheduleId = schedule._id?.toString() ?? '';
    const leaseMs = config.lockLeaseMinutes * MINUTE_MS;
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(new Error('Scheduled prompt run timed out')),
      config.runTimeoutMinutes * MINUTE_MS,
    );
    timeout.unref?.();
    const refreshEvery = Math.max(MIN_LEASE_REFRESH_MS, Math.floor(leaseMs / 3));
    const refreshTimer = setInterval(() => {
      deps
        .refreshLock({ _id: scheduleId, lockOwner, leaseMs })
        .then((stillOwner) => {
          if (!stillOwner && !abortController.signal.aborted) {
            logger.warn(`[PromptScheduler] Lost lease on schedule ${scheduleId}; aborting run`);
            abortController.abort(new Error('Schedule lease lost'));
          }
        })
        .catch((error) => {
          logger.error(`[PromptScheduler] Lease refresh failed for ${scheduleId}:`, error);
        });
    }, refreshEvery);
    refreshTimer.unref?.();

    try {
      await deps.execute(schedule, {
        lockOwner,
        leaseMs,
        signal: abortController.signal,
        trigger: 'schedule',
      });
    } catch (error) {
      logger.error(`[PromptScheduler] Run failed for schedule ${scheduleId}:`, error);
    } finally {
      clearTimeout(timeout);
      clearInterval(refreshTimer);
    }
  };

  const track = (promise: Promise<void>): void => {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  };

  const claimAndStart = async (config: ScheduledPromptsConfig): Promise<number> => {
    const capacity = config.maxConcurrentRuns - inFlight.size;
    if (capacity <= 0) {
      return 0;
    }
    let claimed: IPromptGroup[];
    try {
      claimed = await deps.claimDue({
        now: new Date(),
        lockOwner,
        leaseMs: config.lockLeaseMinutes * MINUTE_MS,
        limit: capacity,
      });
    } catch (error) {
      logger.error('[PromptScheduler] Failed to claim due schedules:', error);
      return 0;
    }
    for (const schedule of claimed) {
      track(runSchedule(schedule, config));
    }
    return claimed.length;
  };

  const runOnce = async (): Promise<number> => {
    if (stopped || ticking) {
      return 0;
    }
    ticking = true;
    try {
      const config = await getConfig();
      if (!config?.enabled) {
        return 0;
      }
      return await claimAndStart(config);
    } finally {
      ticking = false;
    }
  };

  const scheduleNext = (config: ScheduledPromptsConfig | undefined): void => {
    if (stopped) {
      return;
    }
    const baseMs = (config?.pollIntervalSeconds ?? 60) * 1000;
    timer = setTimeout(tick, withJitter(baseMs));
    timer.unref?.();
  };

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    await runOnce();
    scheduleNext(await getConfig());
  }

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await Promise.allSettled([...inFlight]);
  };

  void getConfig().then(scheduleNext);

  if (deps.registerShutdown !== false) {
    registerShutdownTask('prompt scheduler', () => stop(), { phase: 'pre-drain' });
  }

  return {
    lockOwner,
    runOnce,
    stop,
    inFlightCount: () => inFlight.size,
  };
}
