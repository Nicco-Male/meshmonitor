import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TracerouteRequestScheduler } from './tracerouteRequestScheduler.js';

describe('TracerouteRequestScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serializes requests until completion plus cooldown', async () => {
    const scheduler = new TracerouteRequestScheduler(5_000, 75_000);
    const firstSend = vi.fn().mockResolvedValue(undefined);
    const secondSend = vi.fn().mockResolvedValue(undefined);

    await scheduler.enqueue({
      sourceId: 'source-a', localNodeNum: 1, destination: 10, channel: 0,
      priority: 'automatic', send: firstSend,
    });
    const second = scheduler.enqueue({
      sourceId: 'source-b', localNodeNum: 2, destination: 20, channel: 0,
      priority: 'automatic', send: secondSend,
    });

    expect(secondSend).not.toHaveBeenCalled();
    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId: 'source-a', timestamp: Date.now(),
      data: { fromNodeNum: 1, toNodeNum: 10 },
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(secondSend).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same queued source/destination/channel', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 75_000);
    const duplicateSend = vi.fn().mockResolvedValue(undefined);

    await scheduler.enqueue({
      sourceId: 'source-a', localNodeNum: 1, destination: 10, channel: 0,
      send: vi.fn().mockResolvedValue(undefined),
    });
    const one = scheduler.enqueue({
      sourceId: 'source-b', localNodeNum: 2, destination: 20, channel: 1,
      send: duplicateSend,
    });
    const two = scheduler.enqueue({
      sourceId: 'source-b', localNodeNum: 2, destination: 20, channel: 1,
      send: duplicateSend,
    });

    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId: 'source-a', timestamp: Date.now(),
      data: { fromNodeNum: 1, toNodeNum: 10 },
    });
    await Promise.all([one, two]);
    expect(duplicateSend).toHaveBeenCalledTimes(1);
  });

  it('prioritizes manual work ahead of queued automatic work', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 75_000);
    const automaticSend = vi.fn().mockResolvedValue(undefined);
    const manualSend = vi.fn().mockResolvedValue(undefined);

    await scheduler.enqueue({
      sourceId: 'source-a', localNodeNum: 1, destination: 10, channel: 0,
      priority: 'campaign', send: vi.fn().mockResolvedValue(undefined),
    });
    const automatic = scheduler.enqueue({
      sourceId: 'source-b', localNodeNum: 2, destination: 20, channel: 0,
      priority: 'automatic', send: automaticSend,
    });
    const manual = scheduler.enqueue({
      sourceId: 'source-c', localNodeNum: 3, destination: 30, channel: 0,
      priority: 'manual', send: manualSend,
    });

    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId: 'source-a', timestamp: Date.now(),
      data: { fromNodeNum: 1, toNodeNum: 10 },
    });
    await manual;
    expect(manualSend).toHaveBeenCalledTimes(1);
    expect(automaticSend).not.toHaveBeenCalled();

    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId: 'source-c', timestamp: Date.now(),
      data: { fromNodeNum: 3, toNodeNum: 30 },
    });
    await automatic;
    expect(automaticSend).toHaveBeenCalledTimes(1);
  });

  it('releases the slot after timeout when no response arrives', async () => {
    const scheduler = new TracerouteRequestScheduler(1_000, 10_000);
    const secondSend = vi.fn().mockResolvedValue(undefined);

    await scheduler.enqueue({
      sourceId: 'source-a', localNodeNum: 1, destination: 10, channel: 0,
      send: vi.fn().mockResolvedValue(undefined),
    });
    const second = scheduler.enqueue({
      sourceId: 'source-b', localNodeNum: 2, destination: 20, channel: 0,
      send: secondSend,
    });

    await vi.advanceTimersByTimeAsync(10_999);
    expect(secondSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(secondSend).toHaveBeenCalledTimes(1);
  });
});
