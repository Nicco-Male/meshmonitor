import { describe, expect, it } from 'vitest';
import {
  TracerouteCampaignBusyError,
  TracerouteCampaignCoordinator,
} from './tracerouteCampaignCoordinator.js';

describe('TracerouteCampaignCoordinator', () => {
  it('blocks ordinary traceroutes only on sources reserved by a campaign', () => {
    const coordinator = new TracerouteCampaignCoordinator();
    coordinator.reserve('campaign-a', ['source-a', 'source-b']);

    expect(() => coordinator.assertAvailable('source-a')).toThrow(TracerouteCampaignBusyError);
    expect(() => coordinator.assertAvailable('source-c')).not.toThrow();

    coordinator.release('campaign-a');
    expect(() => coordinator.assertAvailable('source-a')).not.toThrow();
  });

  it('reserves all sources atomically when one is already owned', () => {
    const coordinator = new TracerouteCampaignCoordinator();
    coordinator.reserve('campaign-a', ['source-a']);

    expect(() => coordinator.reserve('campaign-b', ['source-b', 'source-a']))
      .toThrow(TracerouteCampaignBusyError);
    expect(coordinator.isReserved('source-b')).toBe(false);
  });
});
