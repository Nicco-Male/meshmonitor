import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import tracerouteCampaignRoutes from './tracerouteCampaignRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { tracerouteCampaignService, type TracerouteCampaignDependencies } from '../services/tracerouteCampaignService.js';
import { tracerouteCampaignCoordinator } from '../services/tracerouteCampaignCoordinator.js';
import { dataEventEmitter } from '../services/dataEventEmitter.js';
import type { CreateTracerouteCampaignInput } from '../../types/tracerouteCampaign.js';

type CampaignManager = NonNullable<ReturnType<TracerouteCampaignDependencies['getManager']>>;

// Only the radios are simulated: the router, service, repositories, users,
// sessions, API tokens and source/channel grants all use their real code.
describe('traceroute campaign API with source/channel permissions', () => {
  let h: RouteTestHarness;
  let sends: Array<{ sourceId: string; target: number; channel: number }>;
  let failingSources: Set<string>;

  beforeEach(async () => {
    h = await createRouteTestApp({ mount: app => app.use('/campaigns', tracerouteCampaignRoutes) });
    sends = [];
    failingSources = new Set();
    for (const [sourceId, nodeNum] of [[h.sourceA, 101], [h.sourceB, 202]] as const) {
      const manager: CampaignManager = {
        sourceId, sourceType: 'meshtastic_tcp',
        start: async () => {}, stop: async () => {},
        startDistanceDeleteScheduler: async () => {}, stopDistanceDeleteScheduler: () => {},
        getStatus: () => ({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
        getLocalNodeInfo: () => ({ nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: sourceId, shortName: sourceId }),
        sendCampaignTraceroute: async (target, channel = 0, _priority, _timeout, guard, lifecycle) => {
          if (guard && !guard()) throw new Error('Cancelled');
          await lifecycle?.onDispatch?.();
          sends.push({ sourceId, target, channel });
          if (failingSources.has(sourceId)) throw new Error('Radio send failed');
        },
      };
      await sourceManagerRegistry.addManager(manager);
    }
  });

  afterEach(async () => {
    const active = tracerouteCampaignService.getActive(h.admin.id, true);
    if (active) tracerouteCampaignService.cancel(active.id, h.admin.id, true);
    await vi.waitFor(() => expect(tracerouteCampaignService.getActive(h.admin.id, true)).toBeNull());
    expect(tracerouteCampaignCoordinator.isReserved(h.sourceA)).toBe(false);
    expect(tracerouteCampaignCoordinator.isReserved(h.sourceB)).toBe(false);
    await sourceManagerRegistry.removeManager(h.sourceA);
    await sourceManagerRegistry.removeManager(h.sourceB);
    await h.cleanup();
  });

  const input = (sourceIds: string[]): CreateTracerouteCampaignInput => ({
    sourceIds, targets: [{ nodeNum: 999 }], recentSuccessHours: 24,
    behavior: 'continue', timeoutSeconds: 5, delaySeconds: 0,
  });

  async function grant(sourceId: string, write = true, channel = true) {
    await h.db.auth.createPermission({
      userId: h.limited.id, resource: 'traceroute', canRead: true, canWrite: write,
      canViewOnMap: false, sourceId, grantedAt: Date.now(), grantedBy: h.admin.id,
    });
    if (channel) await h.grant(h.limited.id, 'channel_0', 'viewOnMap', sourceId);
  }

  it('requires authenticated users even if anonymous has traceroute grants', async () => {
    await h.db.auth.createPermission({
      userId: h.anonymous.id, resource: 'traceroute', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId: h.sourceA, grantedAt: Date.now(), grantedBy: h.admin.id,
    });
    const agent = await h.loginAs(null);
    expect((await agent.post('/campaigns').send(input([h.sourceA]))).status).toBe(401);
    expect((await agent.get('/campaigns/active')).status).toBe(401);
    expect(sends).toHaveLength(0);
  });

  it('rejects malformed input with 400 before reserving any radio', async () => {
    const agent = await h.loginAs(h.admin);
    const response = await agent.post('/campaigns').send({ ...input([h.sourceA]), targets: [null] });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'INVALID_CAMPAIGN_TARGET' });
    expect(sends).toHaveLength(0);
  });

  it('requires write permission on every selected source', async () => {
    await grant(h.sourceA);
    await grant(h.sourceB, false);
    const agent = await h.loginAs(h.limited);
    const response = await agent.post('/campaigns').send(input([h.sourceA, h.sourceB]));
    expect(response.status).toBe(403);
    expect(sends).toHaveLength(0);
  });

  it('requires channel visibility on the actual source, even with its read/write grants', async () => {
    await grant(h.sourceA, true, false);
    await h.grant(h.limited.id, 'channel_0', 'viewOnMap', h.sourceB);
    const agent = await h.loginAs(h.limited);
    expect((await agent.post('/campaigns').send(input([h.sourceA]))).status).toBe(403);
    expect(sends).toHaveLength(0);
  });

  it('starts with canonical source ids, exposes progress and stops pending work', async () => {
    await grant(h.sourceA);
    const agent = await h.loginAs(h.limited);
    const response = await agent.post('/campaigns').send(input([` ${h.sourceA} `, h.sourceA]));
    expect(response.status).toBe(202);
    expect(response.body.success).toBe(true);
    const { id } = response.body.data;
    expect(response.body.data.sources).toMatchObject([{ id: h.sourceA, channel: 0 }]);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect((await agent.get('/campaigns/active')).body.data.campaign.id).toBe(id);
    expect((await agent.get('/campaigns/latest')).body.data.campaign.id).toBe(id);
    const detail = await agent.get(`/campaigns/${id}`);
    expect(detail.body.data.jobs[0]).toMatchObject({ status: 'running', channel: 0 });
    const cancelled = await agent.post(`/campaigns/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
  });

  it('hides another owner campaign while allowing admin inspection', async () => {
    const admin = await h.loginAs(h.admin);
    const response = await admin.post('/campaigns').send(input([h.sourceA]));
    const { id } = response.body.data;
    await grant(h.sourceA);
    const other = await h.loginAs(h.limited);
    expect((await other.get(`/campaigns/${id}`)).status).toBe(404);
    expect((await other.post(`/campaigns/${id}/cancel`)).status).toBe(404);
    expect((await other.post(`/campaigns/${id}/retry`)).status).toBe(404);
    expect((await other.get('/campaigns/active')).body.data.campaign).toBeNull();
    expect((await admin.get(`/campaigns/${id}`)).status).toBe(200);
  });

  it('rechecks source/channel access when reading retained results or cancelling', async () => {
    await grant(h.sourceA);
    const agent = await h.loginAs(h.limited);
    const response = await agent.post('/campaigns').send(input([h.sourceA]));
    const { id } = response.body.data;
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await h.revokeAll(h.limited.id);
    await grant(h.sourceA, true, false);
    for (const path of [id, 'active', 'latest']) {
      const hidden = await agent.get(`/campaigns/${path}`);
      expect(hidden.status).toBe(403);
      expect(hidden.body.data).toBeUndefined();
    }
    expect((await agent.post(`/campaigns/${id}/cancel`)).status).toBe(403);
    const admin = await h.loginAs(h.admin);
    expect((await admin.post(`/campaigns/${id}/cancel`)).status).toBe(200);
  });

  it('accepts real Bearer tokens and rejects a concurrent campaign', async () => {
    const token = await h.tokenFor(h.admin);
    const first = await request(h.app).post('/campaigns').set('Authorization', `Bearer ${token}`).send(input([h.sourceA]));
    expect(first.status).toBe(202);
    const second = await request(h.app).post('/campaigns').set('Authorization', `Bearer ${token}`).send(input([h.sourceB]));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CAMPAIGN_ALREADY_RUNNING');
  });

  it('retries failed attempts through the API after enforcing current write permission', async () => {
    await grant(h.sourceA);
    await grant(h.sourceB);
    failingSources.add(h.sourceB);
    const agent = await h.loginAs(h.limited);
    const response = await agent.post('/campaigns').send(input([h.sourceA, h.sourceB]));
    const { id } = response.body.data;
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    dataEventEmitter.emit('data', { type: 'traceroute:complete', sourceId: h.sourceA, timestamp: Date.now(),
      data: { fromNodeNum: 999, toNodeNum: 101, channel: 0, route: '[]', timestamp: Date.now() } });
    await vi.waitFor(() => expect(tracerouteCampaignService.getActive(h.admin.id, true)).toBeNull());
    await h.revokeAll(h.limited.id);
    await grant(h.sourceA, false);
    await grant(h.sourceB, false);
    expect((await agent.post(`/campaigns/${id}/retry`)).status).toBe(403);
    await h.revokeAll(h.limited.id);
    await grant(h.sourceA, false);
    await grant(h.sourceB);
    failingSources.clear();
    const retried = await agent.post(`/campaigns/${id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.data.retryOfCampaignId).toBe(id);
    expect(retried.body.data.jobs).toHaveLength(1);
    expect(retried.body.data.jobs[0].sourceId).toBe(h.sourceB);
  });
});
