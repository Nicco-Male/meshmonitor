import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataEventEmitter } from './dataEventEmitter.js';
import { TracerouteSchedulerService } from './tracerouteSchedulerService.js';

describe('TracerouteSchedulerService', () => {
  let scheduler: TracerouteSchedulerService;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new TracerouteSchedulerService();
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  function complete(sourceId: string, localNodeNum: number, destination: number) {
    dataEventEmitter.emit('data', {
      type: 'traceroute:complete',
      sourceId,
      timestamp: Date.now(),
      data: {
        fromNodeNum: destination,
        toNodeNum: localNodeNum,
      },
    });
  }

  function enqueue(
    sourceId: string,
    localNodeNum: number,
    destination: number,
    send: () => Promise<void>,
    options: Parameters<TracerouteSchedulerService['enqueue']>[0] = {} as any,
  ) {
    return scheduler.enqueue({
      sourceId,
      localNodeNum,
      destination,
      channel: 0,
      send,
      priority: options.priority,
      rfDomain: options.rfDomain,
      timeoutMs: options.timeoutMs,
      ownerKey: options.ownerKey,
    });
  }

  it('serializes different TCP sources in the same RF domain until response plus cooldown', async () => {
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});

    const first = enqueue('a', 101, 9001, sendA);
    const second = enqueue('b', 202, 9002, sendB);

    await first;
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();

    complete('a', 101, 9001);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sendB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('enforces the Meshtastic minimum gap between two traces from the same source', async () => {
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});

    const first = enqueue('a', 101, 9001, sendA);
    const second = enqueue('a', 101, 9002, sendB);

    await first;
    complete('a', 101, 9001);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(sendB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('dispatches queued jobs by manual, campaign, automatic, retry priority', async () => {
    const activeSend = vi.fn(async () => {});
    const automaticSend = vi.fn(async () => {});
    const campaignSend = vi.fn(async () => {});
    const manualSend = vi.fn(async () => {});
    const retrySend = vi.fn(async () => {});

    await enqueue('active', 100, 8000, activeSend, { priority: 'automatic' } as any);
    const automatic = enqueue('auto', 101, 8001, automaticSend, { priority: 'automatic' } as any);
    const retry = enqueue('retry', 102, 8002, retrySend, { priority: 'retry' } as any);
    const campaign = enqueue('campaign', 103, 8003, campaignSend, { priority: 'campaign' } as any);
    const manual = enqueue('manual', 104, 8004, manualSend, { priority: 'manual' } as any);

    complete('active', 100, 8000);
    await vi.advanceTimersByTimeAsync(5_000);
    await manual;
    expect(manualSend).toHaveBeenCalledTimes(1);
    expect(campaignSend).not.toHaveBeenCalled();

    complete('manual', 104, 8004);
    await vi.advanceTimersByTimeAsync(5_000);
    await campaign;
    expect(campaignSend).toHaveBeenCalledTimes(1);

    complete('campaign', 103, 8003);
    await vi.advanceTimersByTimeAsync(5_000);
    await automatic;
    expect(automaticSend).toHaveBeenCalledTimes(1);

    complete('auto', 101, 8001);
    await vi.advanceTimersByTimeAsync(5_000);
    await retry;
    expect(retrySend).toHaveBeenCalledTimes(1);
  });

  it('allows independent RF domains to run concurrently', async () => {
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});

    const first = enqueue('a', 101, 9001, sendA, { rfDomain: 'toscana' } as any);
    const second = enqueue('b', 202, 9002, sendB, { rfDomain: 'liguria' } as any);

    await Promise.all([first, second]);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same source and destination while queued or active', async () => {
    const send = vi.fn(async () => {});

    const first = enqueue('a', 101, 9001, send, { priority: 'automatic' } as any);
    const duplicate = enqueue('a', 101, 9001, send, { priority: 'manual' } as any);

    expect(duplicate).toBe(first);
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('releases the RF domain after the response timeout', async () => {
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});

    await enqueue('a', 101, 9001, sendA, { timeoutMs: 5_000 } as any);
    const second = enqueue('b', 202, 9002, sendB);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sendB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('cancels owned work that has not transmitted yet', async () => {
    const activeSend = vi.fn(async () => {});
    const campaignSend = vi.fn(async () => {});

    await enqueue('active', 101, 9001, activeSend);
    const queued = enqueue('campaign', 202, 9002, campaignSend, { ownerKey: 'campaign-1' } as any);
    const rejection = expect(queued).rejects.toMatchObject({ code: 'TRACEROUTE_SCHEDULE_CANCELLED' });

    expect(scheduler.cancelQueuedByOwner('campaign-1')).toBe(1);
    await rejection;
    expect(campaignSend).not.toHaveBeenCalled();
  });
});
