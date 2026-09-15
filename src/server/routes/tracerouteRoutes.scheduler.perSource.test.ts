import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { TracerouteRequestScheduler, tracerouteRequestScheduler } from '../services/tracerouteRequestScheduler.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('GET /scheduler/status — source and channel permissions', () => {
  let harness: RouteTestHarness;
  let scheduler: TracerouteRequestScheduler;
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', tracerouteRoutes) });
    scheduler = new TracerouteRequestScheduler(0, 75_000);
    // Exercise the real arbiter with isolated timers; only replace the singleton.
    vi.spyOn(tracerouteRequestScheduler, 'getStatus').mockImplementation(sourceId => scheduler.getStatus(sourceId));
    await scheduler.enqueue({
      sourceId: harness.sourceA, localNodeNum: 1, destination: 10, channel: 0,
      send: async () => {},
    });
    pending = [
      scheduler.enqueue({ sourceId: harness.sourceB, localNodeNum: 2, destination: 20, channel: 1, send: async () => {} }),
      scheduler.enqueue({ sourceId: harness.sourceA, localNodeNum: 1, destination: 30, channel: 2, send: async () => {} }),
    ].map(promise => promise.catch(() => {}));
  });

  afterEach(async () => {
    scheduler.cancelPendingForSource(harness.sourceA);
    scheduler.cancelPendingForSource(harness.sourceB);
    scheduler.handleDataEvent({
      type: 'traceroute:complete', sourceId: harness.sourceA, timestamp: Date.now(),
      data: { fromNodeNum: 10, toNodeNum: 1, channel: 0 },
    });
    await Promise.all(pending);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('requires a source even for an administrator', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/scheduler/status');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });

  it('returns only the requested source, including for an administrator', async () => {
    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get('/scheduler/status').query({ sourceId: harness.sourceA });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ success: true, data: {
      maxActive: 1, cooldownMs: 0,
      active: { sourceId: harness.sourceA, destination: 10 },
      queue: [{ sourceId: harness.sourceA, destination: 30 }],
    } });
    expect(a.body.data.queue).toHaveLength(1);

    const b = await agent.get('/scheduler/status').query({ sourceId: harness.sourceB });
    expect(b.body.data.active).toBeNull();
    expect(b.body.data.queue).toHaveLength(1);
    expect(b.body.data.queue[0].sourceId).toBe(harness.sourceB);
  });

  it('denies another source even when the caller can read a source with queued work', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/scheduler/status').query({ sourceId: harness.sourceB });
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('denies anonymous access without a grant', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/scheduler/status').query({ sourceId: harness.sourceA });
    expect(res.status).toBe(403);
  });

  it('masks both active and queued entries without channel visibility', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const hidden = await agent.get('/scheduler/status').query({ sourceId: harness.sourceA });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toMatchObject({ active: null, queue: [] });

    // A grant for the same channel on B must not expose it on A.
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_2', 'viewOnMap', harness.sourceA);
    const partial = await agent.get('/scheduler/status').query({ sourceId: harness.sourceA });
    expect(partial.body.data.active).toBeNull();
    expect(partial.body.data.queue).toHaveLength(1);
    expect(partial.body.data.queue[0].destination).toBe(30);

    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const visible = await agent.get('/scheduler/status').query({ sourceId: harness.sourceA });
    expect(visible.body.data.active.destination).toBe(10);
  });
});
