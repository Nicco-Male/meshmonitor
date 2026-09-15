import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TracerouteRequestScheduler, type TracerouteRequestPriority } from './tracerouteRequestScheduler.js';

describe('TracerouteRequestScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

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

  const request = (destination: number, sourceId = 'source-a') => ({
    sourceId, localNodeNum: 1, destination, channel: 0,
    send: vi.fn().mockResolvedValue(undefined),
  });

  function complete(scheduler: TracerouteRequestScheduler, destination: number, sourceId = 'source-a') {
    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId, timestamp: Date.now(),
      data: { fromNodeNum: destination, toNodeNum: 1, channel: 0 },
    });
  }

  it('shares the dispatch promise of an active duplicate, but keeps other sources/channels/local nodes distinct', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 100);
    const first = request(10);
    const dispatched = scheduler.enqueue(first);
    expect(scheduler.enqueue({ ...first, send: vi.fn() })).toBe(dispatched);
    await dispatched;

    const otherSource = scheduler.enqueue(request(10, 'source-b'));
    const otherChannel = scheduler.enqueue({ ...request(10), channel: 1 });
    const otherLocalNode = scheduler.enqueue({ ...request(10), localNodeNum: 2 });
    expect(scheduler.getStatus().queue).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([otherSource, otherChannel, otherLocalNode]);
    expect(first.send).toHaveBeenCalledTimes(1);
  });

  it('orders all priorities and preserves FIFO within a priority, with retries last', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 100);
    await scheduler.enqueue(request(10));
    const priorities: TracerouteRequestPriority[] = ['retry', 'automatic', 'automation', 'campaign', 'manual', 'manual'];
    const jobs = priorities.map((priority, index) => ({ ...request(20 + index), priority }));
    const pending = jobs.map(job => scheduler.enqueue(job));

    expect(scheduler.getStatus().queue.map(job => job.destination)).toEqual([24, 25, 23, 22, 21, 20]);
    for (const destination of [10, 24, 25, 23, 22, 21, 20]) {
      complete(scheduler, destination);
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(pending);
    for (const job of jobs) expect(job.send).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().active).toBeNull();
  });

  it('ignores unscoped, other-source, other-channel and unrelated completion events', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 100);
    await scheduler.enqueue(request(10));
    const next = request(20);
    const pending = scheduler.enqueue(next);
    for (const event of [
      { sourceId: undefined, fromNodeNum: 10, toNodeNum: 1, channel: 0 },
      { sourceId: 'source-b', fromNodeNum: 10, toNodeNum: 1, channel: 0 },
      { sourceId: 'source-a', fromNodeNum: 10, toNodeNum: 1, channel: 1 },
      { sourceId: 'source-a', fromNodeNum: 99, toNodeNum: 1, channel: 0 },
    ]) {
      const { sourceId, ...data } = event;
      scheduler.handleDataEvent({ type: 'traceroute:complete', sourceId, data, timestamp: Date.now() });
    }
    expect(next.send).not.toHaveBeenCalled();
    complete(scheduler, 10);
    await pending;
    expect(next.send).toHaveBeenCalledTimes(1);
  });

  it('rejects failed sends and dispatches the next request without wedging the queue', async () => {
    const scheduler = new TracerouteRequestScheduler(5_000, 75_000);
    let failSend!: (error: Error) => void;
    const first = scheduler.enqueue({ ...request(10), send: () => new Promise<void>((_resolve, reject) => { failSend = reject; }) });
    const rejected = expect(first).rejects.toThrow('transport failed');
    const next = request(20);
    const pending = scheduler.enqueue(next);
    failSend(new Error('transport failed'));
    await rejected;
    await pending;
    expect(next.send).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().active?.destination).toBe(20);
  });

  it('skips cancelled requests and throwing dispatch guards without losing subsequent work', async () => {
    const scheduler = new TracerouteRequestScheduler(0, 100);
    await scheduler.enqueue(request(10));
    const cancelled = request(20);
    const failedGuard = request(30);
    const cancelledResult = expect(scheduler.enqueue({ ...cancelled, shouldDispatch: () => false }))
      .rejects.toMatchObject({ code: 'TRACEROUTE_REQUEST_CANCELLED' });
    const failedResult = expect(scheduler.enqueue({ ...failedGuard, shouldDispatch: () => { throw new Error('guard failed'); } }))
      .rejects.toThrow('guard failed');
    const last = request(40);
    const pending = scheduler.enqueue(last);
    complete(scheduler, 10);
    await Promise.all([cancelledResult, failedResult, pending]);
    expect(cancelled.send).not.toHaveBeenCalled();
    expect(failedGuard.send).not.toHaveBeenCalled();
    expect(last.send).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 250])('uses the valid request timeout or the default (%s)', async timeoutMs => {
    const scheduler = new TracerouteRequestScheduler(10, 100);
    await scheduler.enqueue({ ...request(10), timeoutMs });
    const next = request(20);
    const pending = scheduler.enqueue(next);
    const timeout = timeoutMs === 250 ? 250 : 100;
    await vi.advanceTimersByTimeAsync(timeout + 9);
    expect(next.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(next.send).toHaveBeenCalledTimes(1);
  });

  it('waits for a slow send callback to settle even if completion and cooldown arrive first', async () => {
    const scheduler = new TracerouteRequestScheduler(5, 100);
    let finishSend!: () => void;
    const first = scheduler.enqueue({ ...request(10), send: () => new Promise<void>(resolve => { finishSend = resolve; }) });
    const next = request(20);
    const pending = scheduler.enqueue(next);
    complete(scheduler, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(next.send).not.toHaveBeenCalled();
    finishSend();
    await Promise.all([first, pending]);
    // The first callback must not arm a stale timer that releases this job.
    await vi.advanceTimersByTimeAsync(99);
    expect(scheduler.getStatus().active?.destination).toBe(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(scheduler.getStatus().active).toBeNull();
  });

  it('cancels only unsent work for a disconnected source and retains the active RF timeout', async () => {
    const scheduler = new TracerouteRequestScheduler(5, 100);
    await scheduler.enqueue(request(10));
    const cancelled = request(20);
    const cancelledResult = expect(scheduler.enqueue(cancelled)).rejects.toMatchObject({ code: 'TRACEROUTE_REQUEST_CANCELLED' });
    const other = request(30, 'source-b');
    const pending = scheduler.enqueue(other);
    scheduler.cancelPendingForSource('source-a');
    await cancelledResult;
    expect(cancelled.send).not.toHaveBeenCalled();
    expect(scheduler.hasPendingForSource('source-a')).toBe(true);
    expect(scheduler.getStatus('source-b')).toMatchObject({ active: null, queue: [{ sourceId: 'source-b' }] });
    await vi.advanceTimersByTimeAsync(104);
    expect(other.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(scheduler.hasPendingForSource('source-a')).toBe(false);
  });
});
