/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TracerouteCampaignPage from './TracerouteCampaignPage';

const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({
    data: [{ id: 'source-a', name: 'Source A', type: 'meshtastic_tcp', enabled: true }],
  }),
  useSourceStatuses: () => new Map([
    ['source-a', { sourceId: 'source-a', connected: true, nodeNum: 10 }],
  ]),
  useDashboardUnifiedData: () => ({
    nodes: [{ nodeNum: 42, nodeId: '!0000002a', longName: 'Tower Node' }],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../components/Dashboard/TracerouteCampaignPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.current = props;
    return <div data-testid="campaign-panel" />;
  },
}));

vi.mock('../init', () => ({ appBasename: '' }));

function DashboardDestination() {
  const location = useLocation();
  return <div data-testid="dashboard-destination">{String(location.state?.showList)}</div>;
}

describe('TracerouteCampaignPage', () => {
  it('passes the popup target to the page and returns to Unified without blocking navigation', () => {
    const initialTarget = { nodeNum: 42, nodeId: '!0000002a', name: 'Tower Node' };
    render(
      <MemoryRouter initialEntries={[{ pathname: '/unified/traceroute-campaign', state: { initialTarget } }]}>
        <Routes>
          <Route path="/unified/traceroute-campaign" element={<TracerouteCampaignPage />} />
          <Route path="/" element={<DashboardDestination />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('campaign-panel')).toBeInTheDocument();
    expect(panelProps.current?.initialTarget).toEqual(initialTarget);

    fireEvent.click(screen.getByRole('button', { name: /Torna alla mappa/i }));
    expect(screen.getByTestId('dashboard-destination')).toHaveTextContent('true');
  });
});
