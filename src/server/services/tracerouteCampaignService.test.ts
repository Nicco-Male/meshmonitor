import { describe, expect, it, vi } from 'vitest';
import type { DbTraceroute } from '../../db/types.js';
import type { DataEvent } from './dataEventEmitter.js';
import type { CreateTracerouteCampaignInput } from '../../types/tracerouteCampaign.js';
import {
  hasTracerouteResponsePayload,
  orderSourcesByRecentSuccess,
  TracerouteCampaignService,
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
    timestamp,
    createdAt: timestamp,
  };
}

function createHarness(recent: Record<string, DbTraceroute[]> = {}) {
  const listeners = new Set<(event: DataEvent) => void>();
  const sends: Array<{ sourceId: string; target: number; channel: number | undefined }> = [];
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
    sendTraceroute: async (target: number, channel?: number) => { sends.push({ sourceId, target, channel }); },
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
    resolveChannel: async () => 3,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const service = new TracerouteCampaignService(deps);
  const emitSuccess = (sourceId: string, target: number) => {
    const trace = completedTrace(target, localNodes[sourceId], deps.now());
    for (const listener of [...listeners]) {
      listener({ type: 'traceroute:complete', sourceId, data: trace, timestamp: deps.now() });
    }
  };
  return { service, sends, emitSuccess };
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
  it('sends only one request at a time and waits for its response', async () => {
    const { service, sends, emitSuccess } = createHarness();
    const created = await service.create(input(), 7);

    await vi.waitFor(() => expect(sends).toEqual([{ sourceId: 'a', target: 999, channel: 3 }]));
    expect(service.get(created.id, 7)?.jobs[1].status).toBe('queued');

    emitSuccess('a', 999);
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1].sourceId).toBe('b');

    emitSuccess('b', 999);
    await vi.waitFor(() => expect(service.get(created.id, 7)?.status).toBe('completed'));
    expect(service.get(created.id, 7)?.progress.successful).toBe(2);
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
