/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  TRACEROUTE_MAP_MAX_AGE_HOURS,
  useTraceroutePaths,
  type NodePositionDigest,
  type ThemeColors,
  type TracerouteDigest,
} from './useTraceroutePaths';

const nodes: NodePositionDigest[] = [
  {
    nodeNum: 100,
    position: { latitude: 43.7167, longitude: 10.4017 },
    user: { id: '!64', longName: 'Node A' },
  },
  {
    nodeNum: 200,
    position: { latitude: 43.7300, longitude: 10.4200 },
    user: { id: '!c8', longName: 'Node B' },
  },
];

const themeColors: ThemeColors = {
  mauve: '#c6a0f6',
  red: '#ed8796',
  blue: '#8aadf4',
  overlay0: '#6e738d',
};

const callbacks = {
  onSelectNode: () => {},
  onSelectRouteSegment: () => {},
};

function renderBaseMapTrace(timestamp: number) {
  const traceroutes: TracerouteDigest[] = [
    {
      fromNodeNum: 100,
      toNodeNum: 200,
      fromNodeId: '!64',
      toNodeId: '!c8',
      route: '[]',
      routeBack: '[]',
      timestamp,
    },
  ];

  return renderHook(() =>
    useTraceroutePaths({
      showPaths: true,
      showRoute: false,
      selectedNodeId: null,
      currentNodeId: '!64',
      nodesPositionDigest: nodes,
      traceroutesDigest: traceroutes,
      distanceUnit: 'metric',
      // Deliberately larger than the traceroute TTL: node visibility age must
      // not keep stale traceroute lines alive on the base map.
      maxNodeAgeHours: 24,
      themeColors,
      callbacks,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('base-map traceroute TTL', () => {
  it('keeps a stationary trace visible while it is younger than 4 hours', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-21T12:00:00Z');
    vi.setSystemTime(now);

    const { result } = renderBaseMapTrace(now.getTime() - 3 * 60 * 60 * 1000);
    const layer = result.current.traceroutePathsElements?.[0] as any;

    expect(TRACEROUTE_MAP_MAX_AGE_HOURS).toBe(4);
    expect(layer).toBeDefined();
    expect(layer.props.segments.length).toBeGreaterThan(0);
  });

  it('removes a trace from the normal map once it is older than 4 hours', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-21T12:00:00Z');
    vi.setSystemTime(now);

    const { result } = renderBaseMapTrace(now.getTime() - 5 * 60 * 60 * 1000);
    const layer = result.current.traceroutePathsElements?.[0] as any;

    expect(layer).toBeDefined();
    expect(layer.props.segments).toHaveLength(0);
  });
});
