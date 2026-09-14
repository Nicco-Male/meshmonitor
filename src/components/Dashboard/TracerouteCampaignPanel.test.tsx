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
          { nodeNum: 42, nodeId: '!0000002a', longName: 'Tower Node', shortName: 'TWR' },
          { nodeNum: 43, nodeId: '!0000002b', longName: 'Other Node', shortName: 'OTH' },
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
    expect(screen.getByText('TWR')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/short name/i), { target: { value: 'TWR' } });
    expect(screen.getByLabelText(/Tower Node/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Other Node/i)).not.toBeInTheDocument();

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

  it('shows the successful path details and retries only failed attempts', async () => {
    const completed = {
      id: 'campaign-finished',
      ownerId: 1,
      status: 'completed',
      createdAt: Date.now(),
      config: {
        targets: [{ nodeNum: 42, name: 'Tower Node' }],
        sourceIds: ['a', 'b'],
        behavior: 'continue',
        recentSuccessHours: 24,
        timeoutSeconds: 75,
        delaySeconds: 5,
      },
      sources: [],
      jobs: [
        {
          id: 'ok', target: { nodeNum: 42, name: 'Tower Node' }, sourceId: 'a',
          sourceName: 'Source A', localNodeNum: 100, order: 0, recentSuccessAt: null, status: 'success',
          result: {
            route: '[77]', routeBack: '[]', snrTowards: '[40,32]', snrBack: '[28]',
            timestamp: 2_000_000_000_000, hopCount: 2,
          },
        },
        {
          id: 'timeout', target: { nodeNum: 42, name: 'Tower Node' }, sourceId: 'b',
          sourceName: 'Source B', localNodeNum: 200, order: 1, recentSuccessAt: null, status: 'timeout',
          error: 'No traceroute response within 75 seconds',
        },
      ],
      progress: { total: 2, completed: 2, successful: 1, failed: 1, skipped: 0 },
    };
    apiMocks.get
      .mockResolvedValueOnce({ campaign: null })
      .mockResolvedValueOnce({ campaign: completed });
    apiMocks.post.mockResolvedValue({ ...completed, id: 'campaign-retry', status: 'running' });

    render(
      <TracerouteCampaignPanel
        initialTarget={null}
        nodes={[
          { nodeNum: 42, nodeId: '!0000002a', longName: 'Tower Node', shortName: 'TWR' },
          { nodeNum: 77, nodeId: '!0000004d', longName: 'Relay Node', shortName: 'RLY' },
        ]}
        sources={[]}
        sourceStatuses={new Map()}
      />,
    );

    const details = await screen.findByRole('button', { name: /Dettagli traceroute Source A/i });
    expect(screen.queryByText(/Andata · 2 hop/i)).not.toBeInTheDocument();
    fireEvent.click(details);
    expect(screen.getByText(/Andata · 2 hop/i)).toBeInTheDocument();
    expect(screen.getByText(/Ritorno · 1 hop/i)).toBeInTheDocument();
    expect(screen.getByText('RLY')).toBeInTheDocument();
    expect(screen.getAllByText('TWR')).toHaveLength(2);
    expect(screen.getByText('10.0 dB')).toBeInTheDocument();
    expect(screen.getByText('8.0 dB')).toBeInTheDocument();
    expect(screen.getByText('7.0 dB')).toBeInTheDocument();

    const retry = await screen.findByRole('button', { name: /Riprova falliti \(1\)/i });
    fireEvent.click(retry);

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith(
      '/api/traceroute-campaigns/campaign-finished/retry',
    ));
  });
});
