/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TracerouteCampaignPanel from './TracerouteCampaignPanel';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: apiMocks,
}));

describe('TracerouteCampaignPanel', () => {
  beforeEach(() => {
    apiMocks.get.mockReset().mockResolvedValue({ campaign: null });
    apiMocks.post.mockReset().mockResolvedValue({
      id: 'campaign-1',
      ownerId: 1,
      status: 'running',
      createdAt: Date.now(),
      config: {},
      sources: [],
      jobs: [],
      progress: { total: 0, completed: 0, successful: 0, failed: 0, skipped: 0 },
    });
  });

  it('preselects the popup target, excludes unavailable sources, and submits the chosen behavior', async () => {
    render(
      <TracerouteCampaignPanel
        initialTarget={{ nodeNum: 42, nodeId: '!0000002a', name: 'Tower Node' }}
        nodes={[
          { nodeNum: 42, nodeId: '!0000002a', longName: 'Tower Node' },
          { nodeNum: 43, nodeId: '!0000002b', longName: 'Other Node' },
        ]}
        sources={[
          { id: 'a', name: 'Source A', type: 'meshtastic_tcp', enabled: true },
          { id: 'b', name: 'Source B', type: 'meshtastic_tcp', enabled: true },
          { id: 'mqtt', name: 'MQTT', type: 'mqtt_broker', enabled: true },
        ]}
        sourceStatuses={new Map([
          ['a', { sourceId: 'a', connected: true, nodeNum: 100 }],
          ['b', { sourceId: 'b', connected: false }],
        ])}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Tower Node/i)).toBeChecked();
    expect(screen.getByLabelText(/Source A/i)).toBeChecked();
    expect(screen.getByLabelText(/Source B/i)).toBeDisabled();
    expect(screen.queryByLabelText(/MQTT/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Ferma il nodo al primo successo/i));
    const start = await screen.findByRole('button', { name: /Avvia in sequenza/i });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith('/api/traceroute-campaigns', {
      targets: [{ nodeNum: 42, nodeId: '!0000002a', name: 'Tower Node' }],
      sourceIds: ['a'],
      behavior: 'stop-on-success',
      recentSuccessHours: 24,
      timeoutSeconds: 75,
      delaySeconds: 5,
    }));
  });
});
