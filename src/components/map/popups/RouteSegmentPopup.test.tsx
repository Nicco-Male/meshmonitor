/**
 * @vitest-environment jsdom
 */
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import RouteSegmentPopup from './RouteSegmentPopup';

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children?: ReactNode }) => <div data-testid="popup">{children}</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  LineChart: ({ children, data }: { children?: ReactNode; data?: unknown[] }) => (
    <div data-testid="line-chart" data-samples={data?.length ?? 0}>
      {children}
    </div>
  ),
  CartesianGrid: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const segment: TracerouteRenderSegment = {
  key: 'forward:1-2',
  from: [43.7, 10.4],
  to: [43.8, 10.5],
  fromNodeNum: 1,
  toNodeNum: 2,
  leg: 'forward',
  avgSnr: 4,
  isMqtt: false,
};

function renderPopup(
  overrides: Partial<ComponentProps<typeof RouteSegmentPopup>> = {},
) {
  return render(
    <RouteSegmentPopup
      segment={segment}
      fromName="Alpha"
      toName="Bravo"
      distanceUnit="km"
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RouteSegmentPopup', () => {
  it('renders a read-only route segment without SNR statistics when no RF samples exist', () => {
    renderPopup({ isMqtt: true, snrSamples: [{ snr: -32, timestamp: Date.now() }] });

    expect(screen.getByText('TRACEROUTE · Route Segment')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    expect(screen.getByText('via IP')).toBeInTheDocument();
    expect(screen.queryByText(/SNR Statistics/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^SNR:$/)).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).not.toHaveClass('route-node-link');
  });

  it('renders a single SNR sample', () => {
    renderPopup({ snrSamples: [{ snr: 3.25, timestamp: Date.now() }] });

    expect(screen.getByText('SNR:')).toBeInTheDocument();
    expect(screen.getByText('3.3 dB')).toBeInTheDocument();
    expect(screen.queryByText('Average:')).not.toBeInTheDocument();
  });

  it('renders min, max and sample count for two SNR samples', () => {
    renderPopup({
      snrSamples: [
        { snr: -4, timestamp: Date.now() - 1_000 },
        { snr: 6, timestamp: Date.now() },
      ],
    });

    expect(screen.getByText('Min:')).toBeInTheDocument();
    expect(screen.getByText('-4.0 dB')).toBeInTheDocument();
    expect(screen.getByText('Max:')).toBeInTheDocument();
    expect(screen.getByText('6.0 dB')).toBeInTheDocument();
    expect(screen.getByText('Samples:')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Average:')).not.toBeInTheDocument();
  });

  it('renders average and the switchable chart for three timestamped samples', () => {
    const baseTime = new Date('2026-07-27T12:00:00Z').getTime();
    renderPopup({
      snrSamples: [
        { snr: -3, timestamp: baseTime - 2_000 },
        { snr: 3, timestamp: baseTime - 1_000 },
        { snr: 6, timestamp: baseTime },
      ],
    });

    expect(screen.getByText('Average:')).toBeInTheDocument();
    expect(screen.getByText('2.0 dB')).toBeInTheDocument();
    expect(screen.getByTestId('line-chart')).toHaveAttribute('data-samples', '3');

    fireEvent.click(screen.getByRole('button', { name: 'Over Time' }));
    expect(screen.getByTestId('line-chart')).toHaveAttribute('data-samples', '3');
  });

  it('shows distance, source and relative last-seen metadata when provided', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00Z'));

    renderPopup({
      distanceKm: 10,
      distanceUnit: 'mi',
      sourceName: 'NiccoPisa',
      lastSeen: Date.now() - 2 * 60 * 1_000,
    });

    expect(screen.getByText('6.2 mi')).toBeInTheDocument();
    expect(screen.getByText('NiccoPisa')).toBeInTheDocument();
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
  });

  it('keeps the Nodes-map navigation callbacks interactive when supplied', () => {
    const onFromNodeClick = vi.fn();
    const onToNodeClick = vi.fn();
    const onUsageClick = vi.fn();
    renderPopup({
      usageCount: 4,
      onFromNodeClick,
      onToNodeClick,
      onUsageClick,
    });

    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('Bravo'));
    fireEvent.click(screen.getByTitle('Click to view all traceroutes using this segment'));

    expect(onFromNodeClick).toHaveBeenCalledTimes(1);
    expect(onToNodeClick).toHaveBeenCalledTimes(1);
    expect(onUsageClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Alpha')).toHaveClass('route-node-link');
  });
});
