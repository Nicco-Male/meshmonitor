/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceroutePathsLayer } from './TraceroutePathsLayer';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import type { DirectionalTracerouteRenderSegment } from '../../../utils/tracerouteDirections';
import type { SnrColorScale } from '../../../utils/mapHelpers';

vi.mock('react-leaflet', () => ({
  Polyline: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircleMarker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const snrColors: SnrColorScale = {
  excellent: '#111111',
  good: '#222222',
  fair: '#333333',
  poor: '#444444',
  noData: '#555555',
};

function seg(key: string, from: number, to: number, timestamp: number, snr: number): TracerouteRenderSegment {
  return {
    key,
    from: [43.7, 10.4],
    to: [43.8, 10.5],
    fromNodeNum: from,
    toNodeNum: to,
    leg: 'forward',
    avgSnr: snr,
    isMqtt: false,
    timestamp,
  };
}

describe('TraceroutePathsLayer directional summaries', () => {
  it('drops stale reverse evidence before deciding whether a link is bidirectional', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-24T09:00:00Z').getTime();
    vi.setSystemTime(now);

    render(
      <TraceroutePathsLayer
        segments={[
          seg('recent-forward', 100, 200, now - 60 * 60 * 1000, 10),
          seg('stale-reverse', 200, 100, now - 5 * 60 * 60 * 1000, -3),
        ]}
        snrColors={snrColors}
        colorMode="snr"
        weight={2}
        renderPopup={(segment) => {
          const directional = segment as DirectionalTracerouteRenderSegment;
          return <span data-testid="directions">{directional.directionSummaries?.length ?? 0}</span>;
        }}
      />,
    );

    expect(screen.getByTestId('directions')).toHaveTextContent('1');
    vi.useRealTimers();
  });
});
