/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceroutePathsLayer } from './TraceroutePathsLayer';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import type { SnrColorScale } from '../../../utils/mapHelpers';

vi.mock('react-leaflet', () => ({
  Polyline: ({ children }: { children?: ReactNode }) => (
    <div data-testid="polyline">{children}</div>
  ),
  Marker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircleMarker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const snrColors: SnrColorScale = {
  excellent: '#111111',
  good: '#222222',
  fair: '#333333',
  poor: '#444444',
  noData: '#555555',
};

function segment(key: string, timestamp: number): TracerouteRenderSegment {
  return {
    key,
    from: [43.7, 10.4],
    to: [43.8, 10.5],
    fromNodeNum: 100,
    toNodeNum: 200,
    leg: 'forward',
    avgSnr: 2,
    isMqtt: false,
    timestamp,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TraceroutePathsLayer normal-map TTL', () => {
  it('drops stale Dashboard route-segment lines while keeping traces younger than 4 hours', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-21T12:00:00Z');
    vi.setSystemTime(now);

    render(
      <TraceroutePathsLayer
        segments={[
          segment('recent-3h', now.getTime() - 3 * 60 * 60 * 1000),
          segment('stale-22h', now.getTime() - 22 * 60 * 60 * 1000),
        ]}
        snrColors={snrColors}
        colorMode="snr"
        weight={2}
        renderPopup={() => <span>Route Segment</span>}
      />,
    );

    expect(screen.getAllByTestId('polyline')).toHaveLength(1);
  });

  it('applies the same 4-hour TTL to the Dashboard yellow traceroute highlight', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-21T12:00:00Z');
    vi.setSystemTime(now);

    render(
      <TraceroutePathsLayer
        segments={[segment('stale-10h', now.getTime() - 10 * 60 * 60 * 1000)]}
        snrColors={snrColors}
        colorMode="fixed"
        fixedColor="#facc15"
        weight={4}
        renderPopup={() => <span>Route Segment</span>}
      />,
    );

    expect(screen.queryAllByTestId('polyline')).toHaveLength(0);
  });

  it('does not hide an explicit selected/history traceroute just because it is older than 4 hours', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-21T12:00:00Z');
    vi.setSystemTime(now);

    render(
      <TraceroutePathsLayer
        segments={[segment('selected-22h', now.getTime() - 22 * 60 * 60 * 1000)]}
        snrColors={snrColors}
        colorMode="custom"
        segmentColor={() => '#ffffff'}
        weight={4}
        showArrows
        renderPopup={() => <span>Selected traceroute</span>}
      />,
    );

    expect(screen.getAllByTestId('polyline')).toHaveLength(1);
  });
});
