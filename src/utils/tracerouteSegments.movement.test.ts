import { describe, expect, it } from 'vitest';
import {
  TRACEROUTE_MOVEMENT_INVALIDATION_METERS,
  hasTracerouteSnapshotMoved,
  resolveSegmentPosition,
} from './tracerouteSegments';

describe('traceroute movement invalidation', () => {
  const nodeA = 0x11111111;
  const nodeB = 0x22222222;

  it('keeps a snapshot valid when live positions only drift below the threshold', () => {
    const snapshot = new Map<number, [number, number]>([
      [nodeA, [43.7167, 10.4017]],
      [nodeB, [43.7200, 10.4100]],
    ]);
    const live = new Map<number, [number, number]>([
      // Roughly 11 m north of the captured position.
      [nodeA, [43.7168, 10.4017]],
      [nodeB, [43.7200, 10.4100]],
    ]);

    expect(TRACEROUTE_MOVEMENT_INVALIDATION_METERS).toBe(100);
    expect(hasTracerouteSnapshotMoved(snapshot, live)).toBe(false);
    expect(resolveSegmentPosition(nodeA, snapshot, live)).toEqual([43.7167, 10.4017]);
  });

  it('invalidates the whole snapshot when any participating node moved >= 100 m', () => {
    const snapshot = new Map<number, [number, number]>([
      [nodeA, [43.7167, 10.4017]],
      [nodeB, [43.7200, 10.4100]],
    ]);
    const live = new Map<number, [number, number]>([
      // Roughly 220 m north: definitely beyond the invalidation threshold.
      [nodeA, [43.7187, 10.4017]],
      [nodeB, [43.7200, 10.4100]],
    ]);

    expect(hasTracerouteSnapshotMoved(snapshot, live)).toBe(true);
    // The moved node disappears...
    expect(resolveSegmentPosition(nodeA, snapshot, live)).toBeNull();
    // ...and so does an otherwise stationary node from the same trace. This
    // prevents detached stale route fragments from remaining on the map.
    expect(resolveSegmentPosition(nodeB, snapshot, live)).toBeNull();
  });

  it('does not invalidate legacy traces that have no position snapshot', () => {
    const snapshot = new Map<number, [number, number]>();
    const live = new Map<number, [number, number]>([
      [nodeA, [43.7167, 10.4017]],
    ]);

    expect(hasTracerouteSnapshotMoved(snapshot, live)).toBe(false);
    expect(resolveSegmentPosition(nodeA, snapshot, live)).toEqual([43.7167, 10.4017]);
  });

  it('ignores snapshotted nodes with no current live position', () => {
    const snapshot = new Map<number, [number, number]>([
      [nodeA, [43.7167, 10.4017]],
      [nodeB, [43.7200, 10.4100]],
    ]);
    const live = new Map<number, [number, number]>([
      [nodeA, [43.7167, 10.4017]],
    ]);

    expect(hasTracerouteSnapshotMoved(snapshot, live)).toBe(false);
    expect(resolveSegmentPosition(nodeB, snapshot, live)).toEqual([43.7200, 10.4100]);
  });
});
