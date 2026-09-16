import { scheduledPromptsConfigSchema } from 'librechat-data-provider';
import type { ScheduledPromptsConfig } from 'librechat-data-provider';
import type { IPromptGroup } from '@librechat/data-schemas';
import { startPromptScheduler } from './scheduler';
import type { PromptSchedulerDeps } from './scheduler';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function config(overrides: Partial<ScheduledPromptsConfig> = {}): ScheduledPromptsConfig {
  return { ...scheduledPromptsConfigSchema.parse({ enabled: true }), ...overrides };
}

function schedule(id: string): IPromptGroup {
  return { _id: { toString: () => id } } as unknown as IPromptGroup;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function createDeps(overrides: Partial<PromptSchedulerDeps> = {}): PromptSchedulerDeps {
  return {
    getConfig: () => config(),
    claimDue: jest.fn(async () => []),
    refreshLock: jest.fn(async () => true),
    execute: jest.fn(async () => {}),
    lockOwner: 'test-owner',
    registerShutdown: false,
    ...overrides,
  };
}

describe('startPromptScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('polls on the configured interval and executes claimed schedules', async () => {
    const claimDue = jest.fn(async () => [schedule('a'), schedule('b')]);
    const execute = jest.fn(async () => {});
    const deps = createDeps({
      getConfig: () => config({ pollIntervalSeconds: 60 }),
      claimDue,
      execute,
    });
    const scheduler = startPromptScheduler(deps);
    await flushPromises();
    expect(claimDue).not.toHaveBeenCalled();

    jest.advanceTimersByTime(66_000);
    await flushPromises();

    expect(claimDue).toHaveBeenCalledTimes(1);
    expect(claimDue).toHaveBeenCalledWith(
      expect.objectContaining({ lockOwner: 'test-owner', limit: 3, leaseMs: 30 * 60_000 }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockOwner: 'test-owner', trigger: 'schedule' }),
    );
    await scheduler.stop();
  });

  it('does nothing while the feature is disabled', async () => {
    const claimDue = jest.fn(async () => []);
    const scheduler = startPromptScheduler(
      createDeps({ getConfig: () => config({ enabled: false }), claimDue }),
    );
    await flushPromises();
    jest.advanceTimersByTime(70_000);
    await flushPromises();
    expect(claimDue).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('limits claims to the remaining concurrency capacity', async () => {
    const gate = deferred();
    const execute = jest.fn(() => gate.promise);
    const claimDue = jest.fn(async ({ limit }: { limit: number }) =>
      Array.from({ length: limit }, (_, i) => schedule(`s${i}`)),
    );
    const scheduler = startPromptScheduler(
      createDeps({ getConfig: () => config({ maxConcurrentRuns: 2 }), claimDue, execute }),
    );

    await scheduler.runOnce();
    expect(claimDue).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2 }));
    expect(scheduler.inFlightCount()).toBe(2);

    const secondPass = await scheduler.runOnce();
    expect(secondPass).toBe(0);
    expect(claimDue).toHaveBeenCalledTimes(1);

    gate.resolve();
    await flushPromises();
    expect(scheduler.inFlightCount()).toBe(0);
    await scheduler.stop();
  });

  it('refreshes the lease while a run is in flight and aborts when it is lost', async () => {
    const gate = deferred();
    let observedSignal: AbortSignal | undefined;
    const execute = jest.fn(async (_s: IPromptGroup, ctx: { signal: AbortSignal }) => {
      observedSignal = ctx.signal;
      await gate.promise;
    });
    const refreshLock = jest
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const claimDue = jest
      .fn<Promise<IPromptGroup[]>, [unknown]>()
      .mockResolvedValueOnce([schedule('x')])
      .mockResolvedValue([]);
    const scheduler = startPromptScheduler(
      createDeps({
        getConfig: () => config({ lockLeaseMinutes: 3 }),
        claimDue,
        refreshLock,
        execute,
      }),
    );

    await scheduler.runOnce();
    expect(observedSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(refreshLock).toHaveBeenCalledTimes(1);
    expect(refreshLock).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'x', lockOwner: 'test-owner' }),
    );
    expect(observedSignal?.aborted).toBe(false);

    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(refreshLock).toHaveBeenCalledTimes(2);
    expect(observedSignal?.aborted).toBe(true);

    gate.resolve();
    await scheduler.stop();
  });

  it('aborts a run that exceeds the configured timeout', async () => {
    const gate = deferred();
    let observedSignal: AbortSignal | undefined;
    const execute = jest.fn(async (_s: IPromptGroup, ctx: { signal: AbortSignal }) => {
      observedSignal = ctx.signal;
      await gate.promise;
    });
    const claimDue = jest
      .fn<Promise<IPromptGroup[]>, [unknown]>()
      .mockResolvedValueOnce([schedule('t')])
      .mockResolvedValue([]);
    const scheduler = startPromptScheduler(
      createDeps({
        getConfig: () => config({ runTimeoutMinutes: 1, lockLeaseMinutes: 60 }),
        claimDue,
        execute,
      }),
    );
    await scheduler.runOnce();
    jest.advanceTimersByTime(61_000);
    await flushPromises();
    expect(observedSignal?.aborted).toBe(true);
    gate.resolve();
    await scheduler.stop();
  });

  it('stop() waits for in-flight runs and prevents further polling', async () => {
    const gate = deferred();
    const execute = jest.fn(() => gate.promise);
    const claimDue = jest
      .fn<Promise<IPromptGroup[]>, [unknown]>()
      .mockResolvedValueOnce([schedule('z')])
      .mockResolvedValue([]);
    const scheduler = startPromptScheduler(createDeps({ claimDue, execute }));
    await scheduler.runOnce();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flushPromises();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);

    jest.advanceTimersByTime(120_000);
    await flushPromises();
    expect(claimDue).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when a claim or execution throws', async () => {
    const claimDue = jest
      .fn<Promise<IPromptGroup[]>, [unknown]>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([schedule('e')])
      .mockResolvedValue([]);
    const execute = jest.fn(async () => {
      throw new Error('boom');
    });
    const scheduler = startPromptScheduler(
      createDeps({ getConfig: () => config({ pollIntervalSeconds: 15 }), claimDue, execute }),
    );
    await flushPromises();

    jest.advanceTimersByTime(17_000);
    await flushPromises();
    expect(claimDue).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(17_000);
    await flushPromises();
    expect(claimDue).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});
