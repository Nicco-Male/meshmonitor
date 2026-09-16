import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import meshRequestRoutes from './meshRequestRoutes.js';
import actions from './v1/actions.js';
import { requireAPIToken } from '../auth/authMiddleware.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { tracerouteCampaignCoordinator } from '../services/tracerouteCampaignCoordinator.js';

// Exercise the upstream auth chains with real DB grants, stubbing radio IO only.
describe('manual traceroute ingress during a campaign', () => {
  let h: RouteTestHarness;
  let sent: string[];
  beforeEach(async () => {
    h = await createRouteTestApp({ mount: app => {
      app.use('/legacy', meshRequestRoutes);
      app.use('/v1/sources/:sourceId/actions', requireAPIToken(), actions);
    } });
    sent = [];
    for (const sourceId of [h.sourceA, h.sourceB]) {
      const manager: ISourceManager & { sendTraceroute(): Promise<void> } = {
        sourceId, sourceType: 'meshtastic_tcp', start: async () => {}, stop: async () => {},
        startDistanceDeleteScheduler: async () => {}, stopDistanceDeleteScheduler: () => {},
        getLocalNodeInfo: () => null,
        getStatus: () => ({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
        sendTraceroute: async () => { tracerouteCampaignCoordinator.assertAvailable(sourceId); sent.push(sourceId); },
      };
      await sourceManagerRegistry.addManager(manager);
    }
    tracerouteCampaignCoordinator.reserve('route-campaign', [h.sourceA]);
  });
  afterEach(async () => {
    tracerouteCampaignCoordinator.release('route-campaign');
    await sourceManagerRegistry.removeManager(h.sourceA);
    await sourceManagerRegistry.removeManager(h.sourceB);
    await h.cleanup();
  });

  it('returns 409 on a reserved source and preserves legacy success on a free source', async () => {
    await h.grant(h.limited.id, 'traceroute', 'write', h.sourceA);
    await h.grant(h.limited.id, 'traceroute', 'write', h.sourceB);
    const agent = await h.loginAs(h.limited);
    const busy = await agent.post('/legacy/traceroute').send({ sourceId: h.sourceA, destination: 999, channel: 0 });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ success: false, code: 'TRACEROUTE_CAMPAIGN_ACTIVE' });
    const free = await agent.post('/legacy/traceroute').send({ sourceId: h.sourceB, destination: 999, channel: 0 });
    expect(free.status).toBe(200);
    expect(free.body).toMatchObject({ success: true, message: expect.any(String) });
    expect(sent).toEqual([h.sourceB]);
  });

  it('applies v1 token and per-source permissions before reporting a reservation', async () => {
    await h.grant(h.limited.id, 'traceroute', 'write', h.sourceA);
    const token = await h.tokenFor(h.limited);
    const busy = await request(h.app).post(`/v1/sources/${h.sourceA}/actions/traceroute`)
      .set('Authorization', `Bearer ${token}`).send({ destination: 999, channel: 0 });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('TRACEROUTE_CAMPAIGN_ACTIVE');
    const denied = await request(h.app).post(`/v1/sources/${h.sourceB}/actions/traceroute`)
      .set('Authorization', `Bearer ${token}`).send({ destination: 999, channel: 0 });
    expect(denied.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
