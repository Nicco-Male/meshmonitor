import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbTraceroute } from '../../db/types.js';
import { TracerouteRequestScheduler } from './tracerouteRequestScheduler.js';
import type { DataEvent } from './dataEventEmitter.js';
import type { CreateTracerouteCampaignInput } from '../../types/tracerouteCampaign.js';
import {
  hasTracerouteResponsePayload,
  orderSourcesByRecentSuccess,
  TracerouteCampaignService,
  validateTracerouteCampaignInput,
  type TracerouteCampaignDependencies,
} from './tracerouteCampaignService.js';

// The service is dependency-injected in these tests. Keep its production DB
// singleton out of the module graph (and avoid loading native DB dependencies).
vi.mock('../../services/database.js', () => ({
  default: { sources: {}, traceroutes: {} },
}));

function completedTrace(localNodeNum: number, targetNodeNum: number, timestamp: number): DbTraceroute {
  return {
    fromNodeNum: localNodeNum,
    toNodeNum: targetNodeNum,
    fromNodeId: `!${localNodeNum.toString(16)}`,
    toNodeId: `!${targetNodeNum.toString(16)}`,
    route: '[]',
    routeBack: '[]',
    snrTowards: '[]',
    snrBack: '[]',
    channel: 3,
    timestamp,
    createdAt: timestamp,
  };
}

function createHarness(
  recent: Record<string, DbTraceroute[]> = {},
  failingSources = new Set<string>(),
) {
  const listeners = new Set<(event: DataEvent) => void>();
  const sends: Array<{ sourceId: string; target: number; channel: number | undefined }> = [];
  const reservations = new Map<string, string>();
  let id = 0;
  const localNodes: Record<string, number> = { a: 101, b: 202, c: 303 };
  const managers = new Map(Object.entries(localNodes).map(([sourceId, localNodeNum]) => [sourceId, {
    sourceId,
    sourceType: 'meshtastic_tcp' as const,
    start: vi.fn(),
    stop: vi.fn(),
    startDistanceDeleteScheduler: vi.fn(),
    stopDistanceDeleteScheduler: vi.fn(),
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp' as const, connected: true }),
    getLocalNodeInfo: () => ({ nodeNum: localNodeNum, nodeId: `!${localNodeNum.toString(16)}`, longName: sourceId, shortName: sourceId }),
    sendCampaignTraceroute: vi.fn<NonNullable<ReturnType<TracerouteCampaignDependencies['getManager']>>['sendCampaignTraceroute']>(async (target, channel, _priority, _timeout, guard, lifecycle) => {
      if (guard && !guard()) throw new Error('Cancelled before dispatch');
      await lifecycle?.onDispatch?.();
      sends.push({ sourceId, target, channel });
      if (failingSources.has(sourceId)) throw new Error(`Send failed on ${sourceId}`);
    }),
  }]));

  const deps: TracerouteCampaignDependencies = {
    now: () => 2_000_000_000_000,
    createId: () => `id-${++id}`,
    getSources: async () => Object.keys(localNodes).map((sourceId, displayOrder) => ({
      id: sourceId,
      name: `Source ${sourceId.toUpperCase()}`,
      type: 'meshtastic_tcp',
      enabled: true,
      displayOrder,
    })),
    getManager: (sourceId) => managers.get(sourceId),
    getRecentTraceroutes: async (sourceId, _local, target) => recent[`${sourceId}:${target}`] ?? [],
    authorize: async () => true,
    resolveChannel: async () => 3,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reserveSources: (campaignId, sourceIds) => {
      for (const sourceId of sourceIds) reservations.set(sourceId, campaignId);
    },
    releaseSources: (campaignId) => {
      for (const [sourceId, owner] of reservations) {
        if (owner === campaignId) reservations.delete(sourceId);
      }
    },
  };
  const service = new TracerouteCampaignService(deps);
  const emitSuccess = (sourceId: string, target: number) => {
    const trace = completedTrace(target, localNodes[sourceId], deps.now());
    for (const listener of [...listeners]) {
      listener({ type: 'traceroute:complete', sourceId, data: trace, timestamp: deps.now() });
    }
  };
  const emit = (event: DataEvent) => { for (const listener of [...listeners]) listener(event); };
  return { service, sends, emitSuccess, reservations, deps, managers, listeners, emit };
}

function input(overrides: Partial<CreateTracerouteCampaignInput> = {}): CreateTracerouteCampaignInput {
  return {
    targets: [{ nodeNum: 999, nodeId: '!000003e7', name: 'Target' }],
    sourceIds: ['a', 'b'],
    recentSuccessHours: 24,
    behavior: 'continue',
    timeoutSeconds: 75,
    delaySeconds: 0,
    ...overrides,
  };
}

describe('TracerouteCampaignService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('sends only one request at a time and waits for its response', async () => {
    const { service, sends, emitSuccess, reservations } = createHarness();
    const created = await service.create(input(), 7);

    await vi.waitFor(() => expect(sends).toEqual([{ sourceId: 'a', target: 999, channel: 3 }]));
    expect([...reservations.keys()]).toEqual(['a', 'b']);
    expect(service.get(created.id, 7)?.jobs[1].status).toBe('queued');

    emitSuccess('a', 999);
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1].sourceId).toBe('b');

    emitSuccess('b', 999);
    await vi.waitFor(() => expect(service.get(created.id, 7)?.status).toBe('completed'));
    expect(service.get(created.id, 7)?.progress.successful).toBe(2);
    await vi.waitFor(() => expect(reservations.size).toBe(0));
  });

  it('prioritizes the newest recent success and skips remaining sources after success when configured', async () => {
    const now = 2_000_000_000_000;
    const { service, sends, emitSuccess } = createHarness({
      'a:999': [completedTrace(101, 999, now - 2 * 60 * 60 * 1000)],
      'b:999': [completedTrace(202, 999, now - 30 * 60 * 1000)],
    });
    const created = await service.create(input({ behavior: 'stop-on-success' }), 7);

    await vi.waitFor(() => expect(sends[0]?.sourceId).toBe('b'));
    emitSuccess('b', 999);
    await vi.waitFor(() => expect(service.get(created.id, 7)?.status).toBe('completed'));

    expect(sends.map((send) => send.sourceId)).toEqual(['b']);
    expect(service.get(created.id, 7)?.jobs.map((job) => job.status)).toEqual(['success', 'skipped']);
  });

  it('cancels the active waiter and all queued work', async () => {
    const { service, sends } = createHarness();
    const created = await service.create(input(), 7);
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    service.cancel(created.id, 7);
    await vi.waitFor(() => expect(service.get(created.id, 7)?.status).toBe('cancelled'));
    expect(service.get(created.id, 7)?.jobs.every((job) => job.status === 'cancelled')).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it('creates a new campaign containing only timeout/error attempts when retried', async () => {
    const failingSources = new Set(['b']);
    const { service, sends, emitSuccess } = createHarness({}, failingSources);
    const original = await service.create(input(), 7);

    await vi.waitFor(() => expect(sends[0]?.sourceId).toBe('a'));
    emitSuccess('a', 999);
    await vi.waitFor(() => expect(service.get(original.id, 7)?.status).toBe('completed'));
    expect(service.get(original.id, 7)?.jobs.map((job) => job.status)).toEqual(['success', 'error']);

    failingSources.delete('b');
    const retried = await service.retry(original.id, 7);
    expect(retried?.retryOfCampaignId).toBe(original.id);
    expect(retried?.jobs).toHaveLength(1);
    expect(retried?.jobs[0]).toMatchObject({ sourceId: 'b', order: 0 });

    await vi.waitFor(() => expect(sends).toHaveLength(3));
    emitSuccess('b', 999);
    await vi.waitFor(() => expect(service.get(retried!.id, 7)?.status).toBe('completed'));
    expect(service.get(retried!.id, 7)?.progress.successful).toBe(1);
  });
  it('keeps stop-on-success local to each target and preserves target order', async () => {
    const h = createHarness();
    const c = await h.service.create(input({ behavior: 'stop-on-success', targets: [{ nodeNum: 999 }, { nodeNum: 888 }] }), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    h.emitSuccess('a', 999);
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]).toMatchObject({ sourceId: 'a', target: 888 });
    h.emitSuccess('a', 888);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(c.id, 7)?.jobs.map(j => j.status)).toEqual(['success', 'skipped', 'success', 'skipped']);
    expect(h.listeners.size).toBe(0);
  });

  it('times out, respects the configured delay, and retries only failures at retry priority', async () => {
    const h = createHarness();
    const c = await h.service.create(input({ timeoutSeconds: 5, delaySeconds: 2 }), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.service.get(c.id, 7)?.jobs[0].status).toBe('timeout');
    expect(h.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sends).toHaveLength(2);
    h.emitSuccess('b', 999);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    const retry = await h.service.retry(c.id, 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(3));
    expect(h.managers.get('a')!.sendCampaignTraceroute.mock.lastCall?.[2]).toBe('retry');
    h.emitSuccess('a', 999);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(retry!.id, 7)?.progress).toMatchObject({ total: 1, successful: 1, failed: 0 });
  });

  it('ignores other sources, channels, endpoints and pending rows, and records hop details', async () => {
    const h = createHarness();
    const c = await h.service.create(input({ sourceIds: ['a'] }), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    const trace = completedTrace(101, 999, h.deps.now());
    for (const [sourceId, data] of [
      ['b', trace], ['a', { ...trace, channel: 2 }], ['a', { ...trace, toNodeNum: 998 }],
      ['a', { ...trace, route: null, routeBack: null, snrTowards: null, snrBack: null }],
    ] as const) h.emit({ type: 'traceroute:complete', sourceId, data, timestamp: h.deps.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.get(c.id, 7)?.jobs[0].status).toBe('running');
    h.emit({ type: 'traceroute:complete', sourceId: 'a', data: { ...trace, route: '[123,456]', snrTowards: '[8,12]' }, timestamp: h.deps.now() });
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(c.id, 7)?.jobs[0].result).toMatchObject({ hopCount: 3, route: '[123,456]', snrTowards: '[8,12]' });
    expect(h.listeners.size).toBe(0);
  });

  it('cancels queued work immediately without releasing another request RF slot', async () => {
    const h = createHarness();
    const scheduler = new TracerouteRequestScheduler(0, 75_000);
    await scheduler.enqueue({ sourceId: 'other', localNodeNum: 1, destination: 2, channel: 0, send: async () => {} });
    const manager = h.managers.get('a')!;
    const send = manager.sendCampaignTraceroute.getMockImplementation()!;
    manager.sendCampaignTraceroute.mockImplementation((target, channel = 0, priority, timeoutMs, shouldDispatch, lifecycle) =>
      scheduler.enqueue({ sourceId: 'a', localNodeNum: 101, destination: target, channel, priority, timeoutMs, shouldDispatch,
        signal: lifecycle?.signal, send: () => send(target, channel, priority, timeoutMs, shouldDispatch, lifecycle) }));
    const c = await h.service.create(input({ sourceIds: ['a'] }), 7);
    await vi.waitFor(() => expect(scheduler.getStatus().queue).toHaveLength(1));
    h.emitSuccess('a', 999); // A prior trace cannot complete an unsent attempt.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.get(c.id, 7)?.jobs[0].status).toBe('queued');
    h.service.cancel(c.id, 7);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(scheduler.getStatus()).toMatchObject({ active: { sourceId: 'other' }, queue: [] });
    expect(h.listeners.size).toBe(0);
    expect(h.sends).toHaveLength(0);
    expect(h.service.getActive(7)).toBeNull();
  });

  it('rechecks permissions at dispatch after waiting in the shared queue', async () => {
    const h = createHarness();
    let dispatch!: () => void;
    const manager = h.managers.get('a')!;
    const send = manager.sendCampaignTraceroute.getMockImplementation()!;
    manager.sendCampaignTraceroute.mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { dispatch = resolve; });
      await send(...args);
    });
    const c = await h.service.create(input({ sourceIds: ['a'] }), 7);
    await vi.waitFor(() => expect(dispatch).toBeDefined());
    h.deps.authorize = async () => false;
    dispatch();
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.sends).toHaveLength(0);
    expect(h.service.get(c.id, 7)?.jobs[0]).toMatchObject({ status: 'error', error: expect.stringContaining('revoked') });
  });

  it('captures a response arriving before the send promise resolves', async () => {
    const h = createHarness();
    h.managers.get('a')!.sendCampaignTraceroute.mockImplementation(async (_target, _channel, _priority, _timeout, _guard, lifecycle) => {
      await lifecycle?.onDispatch?.();
      h.emitSuccess('a', 999);
    });
    const c = await h.service.create(input({ sourceIds: ['a'] }), 7);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(c.id, 7)?.jobs[0]).toMatchObject({ status: 'success', result: { hopCount: 1 } });
  });

  it('releases reservations and waiters on disconnect, and continues on another source', async () => {
    const h = createHarness();
    const c = await h.service.create(input(), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    h.emit({ type: 'connection:status', sourceId: 'a', data: { connected: false }, timestamp: h.deps.now() });
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    h.emitSuccess('b', 999);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(c.id, 7)?.jobs.map(j => j.status)).toEqual(['error', 'success']);
    expect(h.listeners.size).toBe(0);
  });

  it('cancels a delay without dispatching the next source and enforces owner/admin access', async () => {
    const h = createHarness();
    const c = await h.service.create(input({ delaySeconds: 300 }), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    h.emitSuccess('a', 999);
    await vi.waitFor(() => expect(h.service.get(c.id, 7)?.progress.successful).toBe(1));
    expect(h.service.get(c.id, 8)).toBeNull();
    expect(h.service.getLatest(8)).toBeNull();
    expect(h.service.cancel(c.id, 8)).toBeNull();
    await expect(h.service.retry(c.id, 8)).resolves.toBeNull();
    expect(h.service.getActive(8, true)?.id).toBe(c.id);
    h.service.cancel(c.id, 8, true);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.sends).toHaveLength(1);
    expect(h.service.get(c.id, 7)?.jobs.map(j => j.status)).toEqual(['success', 'cancelled']);
  });

  it('rejects concurrent creation and releases reservations after a preparation failure', async () => {
    const h = createHarness();
    let rejectLookup!: (error: Error) => void;
    h.deps.getRecentTraceroutes = () => new Promise((_resolve, reject) => { rejectLookup = reject; });
    const creating = expect(h.service.create(input(), 7)).rejects.toThrow('lookup failed');
    await vi.waitFor(() => expect(rejectLookup).toBeDefined());
    await expect(h.service.create(input(), 7)).rejects.toMatchObject({ code: 'CAMPAIGN_ALREADY_RUNNING' });
    rejectLookup(new Error('lookup failed'));
    await creating;
    expect(h.reservations.size).toBe(0);
    expect(h.sends).toHaveLength(0);
    h.deps.getRecentTraceroutes = async () => [];
    const c = await h.service.create(input(), 7);
    h.service.cancel(c.id, 7);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
  });

  it('validates source availability and live channel permissions before reserving', async () => {
    const h = createHarness();
    await expect(h.service.create(input({ sourceIds: ['missing'] }), 7)).rejects.toMatchObject({ code: 'INVALID_CAMPAIGN_SOURCE' });
    h.deps.authorize = async () => false;
    await expect(h.service.create(input(), 7)).rejects.toMatchObject({ status: 403 });
    expect(h.reservations.size).toBe(0);
    expect(h.sends).toHaveLength(0);
  });

  it('rejects changed local nodes before a later attempt and skips self-targets', async () => {
    const h = createHarness();
    const c = await h.service.create(input({ targets: [{ nodeNum: 101 }, { nodeNum: 999 }] }), 7);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.sends[0]).toMatchObject({ sourceId: 'b', target: 101 });
    h.managers.get('a')!.getLocalNodeInfo = () => ({ nodeNum: 505, nodeId: '!000001f9', shortName: 'new', longName: 'new' });
    h.emitSuccess('b', 101);
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    h.emitSuccess('b', 999);
    await vi.waitFor(() => expect(h.reservations.size).toBe(0));
    expect(h.service.get(c.id, 7)?.jobs.map(j => j.status)).toEqual(['skipped', 'success', 'error', 'success']);
  });

});

describe('traceroute campaign ordering helpers', () => {
  it('treats an empty direct route as a completed response', () => {
    expect(hasTracerouteResponsePayload({ route: '[]' })).toBe(true);
    expect(hasTracerouteResponsePayload({ route: null, routeBack: null, snrTowards: null, snrBack: null })).toBe(false);
  });

  it('orders recent successes newest-first, then preserves selection order', () => {
    const ordered = orderSourcesByRecentSuccess([
      { id: 'a', selectedOrder: 0, recentSuccessAt: null },
      { id: 'b', selectedOrder: 1, recentSuccessAt: 20 },
      { id: 'c', selectedOrder: 2, recentSuccessAt: 30 },
      { id: 'd', selectedOrder: 3, recentSuccessAt: null },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});


describe('campaign input validation', () => {
  it.each([
    { targets: [] }, { targets: [null] }, { targets: [{ nodeNum: true }] },
    { targets: [{ nodeNum: 0xffffffff }] }, { targets: [{ nodeNum: -1 }] },
    { sourceIds: [' '] }, { sourceIds: [1] }, { behavior: 'invalid' },
    { timeoutSeconds: 4 }, { delaySeconds: -1 }, { recentSuccessHours: 721 },
    { targets: Array.from({ length: 101 }, (_, i) => ({ nodeNum: i + 1 })) },
    { sourceIds: Array.from({ length: 21 }, (_, i) => String(i)) },
  ])('rejects invalid input before any IO: %j', overrides => {
    expect(() => validateTracerouteCampaignInput({ ...input(), ...overrides } as CreateTracerouteCampaignInput)).toThrow();
  });

  it('canonicalizes source ids and deduplicates targets while preserving selection order', () => {
    const value = validateTracerouteCampaignInput(input({ sourceIds: [' a ', 'b', 'a'], targets: [{ nodeNum: 42 }, { nodeNum: 99 }, { nodeNum: 42, name: ' Last ' }] }));
    expect(value.sourceIds).toEqual(['a', 'b']);
    expect(value.targets).toEqual([{ nodeNum: 42, name: 'Last' }, { nodeNum: 99 }]);
  });
});
