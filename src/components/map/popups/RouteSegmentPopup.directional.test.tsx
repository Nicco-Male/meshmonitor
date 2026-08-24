/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import type { DirectionalTracerouteRenderSegment } from '../../../utils/tracerouteDirections';
import RouteSegmentPopup from './RouteSegmentPopup';

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const baseSegment: TracerouteRenderSegment = {
  key: 'segment',
  from: [43.7, 10.4],
  to: [43.8, 10.5],
  fromNodeNum: 100,
  toNodeNum: 200,
  leg: 'neutral',
  avgSnr: 6,
  isMqtt: false,
};

function renderDirectional(segment: DirectionalTracerouteRenderSegment) {
  return render(
    <RouteSegmentPopup
      segment={segment}
      fromName="Alpha"
      toName="Bravo"
      distanceUnit="km"
    />,
  );
}

describe('RouteSegmentPopup directional evidence', () => {
  it('shows a one-way segment when only A-to-B evidence exists', () => {
    renderDirectional({
      ...baseSegment,
      directionSummaries: [{
        fromNodeNum: 100,
        toNodeNum: 200,
        usageCount: 2,
        snrSamples: [{ snr: 10 }, { snr: 12 }],
        hasMqtt: false,
        latestTimestamp: 2_000,
      }],
    });

    expect(screen.getByTestId('route-direction')).toHaveAttribute('data-direction', 'one-way');
    expect(screen.getByTestId('direction-100-200')).toHaveTextContent('2 traceroutes');
    expect(screen.getByTestId('direction-100-200')).toHaveTextContent('11.0 dB avg');
  });

  it('shows bidirectional only when both directions have evidence', () => {
    renderDirectional({
      ...baseSegment,
      directionSummaries: [
        {
          fromNodeNum: 100,
          toNodeNum: 200,
          usageCount: 2,
          snrSamples: [{ snr: 10 }, { snr: 12 }],
          hasMqtt: false,
          latestTimestamp: 2_000,
        },
        {
          fromNodeNum: 200,
          toNodeNum: 100,
          usageCount: 1,
          snrSamples: [{ snr: -4 }],
          hasMqtt: false,
          latestTimestamp: 3_000,
        },
      ],
    });

    expect(screen.getByTestId('route-direction')).toHaveAttribute('data-direction', 'bidirectional');
    expect(screen.getByTestId('direction-100-200')).toHaveTextContent('11.0 dB avg');
    expect(screen.getByTestId('direction-200-100')).toHaveTextContent('-4.0 dB avg');
  });
});
