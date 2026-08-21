import { describe, expect, it } from 'vitest';
import {
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  TRACEROUTE_MOVEMENT_INVALIDATION_METERS,
} from './tracerouteSegments';

describe('historical traceroute snapshot geometry', () => {
  it('does not mix a current live position into a partial capture snapshot', () => {
    const snapshot = parseSnapshotRoutePositions(JSON.stringify({
      100: { lat: 43.7167, lng: 10.4017 },
    }));
    const live = new Map<number, [number, number]>([
      [100, [43.7167, 10.4017]],
      [200, [43.7300, 10.4200]],
    ]);

    expect(resolveSegmentPosition(100, snapshot, live)).toEqual([43.7167, 10.4017]);
    expect(resolveSegmentPosition(200, snapshot, live)).toBeNull();
  });

  it('invalidates the whole capture snapshot once a snapshotted node moves beyond the threshold', () => {
    const snapshot = parseSnapshotRoutePositions(JSON.stringify({
      100: { lat: 43.7167, lng: 10.4017 },
      200: { lat: 43.7200, lng: 10.4100 },
    }));
    const live = new Map<number, [number, number]>([
      [100, [43.7167, 10.4017]],
      // Roughly 1 km from the captured point: comfortably above the 100 m guard.
      [200, [43.7290, 10.4100]],
    ]);

    expect(TRACEROUTE_MOVEMENT_INVALIDATION_METERS).toBe(100);
    expect(resolveSegmentPosition(100, snapshot, live)).toBeNull();
    expect(resolveSegmentPosition(200, snapshot, live)).toBeNull();
  });

  it('keeps the legacy live-position fallback only when no capture snapshot exists at all', () => {
    const snapshot = parseSnapshotRoutePositions(undefined);
    const live = new Map<number, [number, number]>([[200, [43.7300, 10.4200]]]);

    expect(resolveSegmentPosition(200, snapshot, live)).toEqual([43.7300, 10.4200]);
  });
});
