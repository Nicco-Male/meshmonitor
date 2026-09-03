/**
 * Runs in the default node environment — tracerouteSegments.ts is pure and
 * leaflet-free (#4047 P3 WP2).
 */
import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_SNR_SENTINEL,
  isUnknownSnr,
  isUnknownRouteNode,
  isValidRouteNode,
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  consolidateEstimatedNodePositions,
  hasReturnPath,
  decomposeTraceroute,
  type TracerouteDecomposeInput,
} from './tracerouteSegments';

describe('isUnknownSnr / UNKNOWN_SNR_SENTINEL (#2931, re-homed from mapHelpers)', () => {
  it('is -32 (firmware INT8_MIN / 4)', () => {
    expect(UNKNOWN_SNR_SENTINEL).toBe(-32);
  });

  it('treats -32 as unknown', () => {
    expect(isUnknownSnr(-32)).toBe(true);
  });

  it('treats 0 (protobuf default) as NOT unknown', () => {
    expect(isUnknownSnr(0)).toBe(false);
  });

  it('treats undefined as NOT unknown', () => {
    expect(isUnknownSnr(undefined)).toBe(false);
  });
});

describe('consolidateEstimatedNodePositions', () => {
  it('uses one centroid position for every occurrence of the same real node ID', () => {
    const segments = [
      {
        key: 'trace-1-into',
        from: [0, 0] as [number, number],
        to: [10, 20] as [number, number],
        fromNodeNum: 100,
        toNodeNum: 0x1234fb3c,
        toPositionEstimated: true,
        leg: 'forward' as const,
        avgSnr: 5,
        isMqtt: false,
        timestamp: 1,
      },
      {
        key: 'trace-1-out',
        from: [10, 20] as [number, number],
        to: [30, 30] as [number, number],
        fromNodeNum: 0x1234fb3c,
        toNodeNum: 200,
        fromPositionEstimated: true,
        leg: 'forward' as const,
        avgSnr: 4,
        isMqtt: false,
        timestamp: 1,
      },
      {
        key: 'trace-2-into',
        from: [40, 40] as [number, number],
        to: [20, 30] as [number, number],
        fromNodeNum: 300,
        toNodeNum: 0x1234fb3c,
        toPositionEstimated: true,
        leg: 'return' as const,
        avgSnr: 3,
        isMqtt: false,
        timestamp: 2,
      },
      {
        key: 'trace-2-out',
        from: [20, 30] as [number, number],
        to: [50, 50] as [number, number],
        fromNodeNum: 0x1234fb3c,
        toNodeNum: 400,
        fromPositionEstimated: true,
        leg: 'return' as const,
        avgSnr: 2,
        isMqtt: false,
        timestamp: 2,
      },
    ];

    const consolidated = consolidateEstimatedNodePositions(segments);
    expect(consolidated[0].to).toEqual([15, 25]);
    expect(consolidated[1].from).toEqual([15, 25]);
    expect(consolidated[2].to).toEqual([15, 25]);
    expect(consolidated[3].from).toEqual([15, 25]);
  });

  it('does not merge anonymous 0xffffffff hops from unrelated traces', () => {
    const segments = [
      {
        key: 'trace-1',
        from: [0, 0] as [number, number],
        to: [10, 10] as [number, number],
        fromNodeNum: 100,
        toNodeNum: 0xffffffff,
        toPositionEstimated: true,
        leg: 'forward' as const,
        avgSnr: null,
        isMqtt: true,
      },
      {
        key: 'trace-2',
        from: [20, 20] as [number, number],
        to: [30, 30] as [number, number],
        fromNodeNum: 0xffffffff,
        toNodeNum: 200,
        fromPositionEstimated: true,
        leg: 'forward' as const,
        avgSnr: null,
        isMqtt: true,
      },
    ];

    const consolidated = consolidateEstimatedNodePositions(segments);
    expect(consolidated[0].to).toEqual([10, 10]);
    expect(consolidated[1].from).toEqual([20, 20]);
  });
});

describe('parseSnapshotRoutePositions (#1862)', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseSnapshotRoutePositions(undefined).size).toBe(0);
    expect(parseSnapshotRoutePositions(null).size).toBe(0);
    expect(parseSnapshotRoutePositions('').size).toBe(0);
  });

  it('returns an empty map for malformed JSON', () => {
    expect(parseSnapshotRoutePositions('{not json').size).toBe(0);
  });

  it('parses a valid snapshot into a nodeNum -> [lat,lng] map', () => {
    const snap = JSON.stringify({
      100: { lat: 10.5, lng: 20.5 },
      200: { lat: -5, lng: -10, alt: 123 },
    });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.get(100)).toEqual([10.5, 20.5]);
    expect(result.get(200)).toEqual([-5, -10]);
  });

  it('skips entries missing lat or lng', () => {
    const snap = JSON.stringify({
      100: { lat: 10.5 }, // missing lng
      200: { lng: 20.5 }, // missing lat
      300: { lat: 1, lng: 2 },
    });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.has(100)).toBe(false);
    expect(result.has(200)).toBe(false);
    expect(result.get(300)).toEqual([1, 2]);
  });

  it('keeps a single-axis-zero position (typeof-number check, not truthy)', () => {
    // Regression guard for the 3-way diff finding: two of the three
    // pre-existing implementations used a truthy `snapshot?.lat && snapshot?.lng`
    // check that silently dropped nodes sitting exactly on lat=0 or lng=0.
    // A single axis at 0 (with the other far from 0) is a real position.
    const snap = JSON.stringify({ 100: { lat: 0, lng: 20.5 }, 200: { lat: 51.5, lng: 0 } });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.get(100)).toEqual([0, 20.5]);
    expect(result.get(200)).toEqual([51.5, 0]);
  });

  it('drops a Null-Island snapshot so it does not anchor a route at (0,0) (#02ecd5e0)', () => {
    // A snapshot captured while the node held a garbage GPS default — the exact
    // (0,0) pair or the 2^15 value 0.0032768 — must be skipped so the segment
    // falls through to the live position instead of shooting out to Null Island.
    const snap = JSON.stringify({ 100: { lat: 0, lng: 0 }, 200: { lat: 0.0032768, lng: 0.0032768 } });
    const result = parseSnapshotRoutePositions(snap);
    expect(result.has(100)).toBe(false);
    expect(result.has(200)).toBe(false);
  });
});

describe('resolveSegmentPosition', () => {
  it('prefers the snapshot position over the live position', () => {
    const snapshot = new Map<number, [number, number]>([[1, [1, 1]]]);
    const live = new Map<number, [number, number]>([[1, [9, 9]]]);
    expect(resolveSegmentPosition(1, snapshot, live)).toEqual([1, 1]);
  });

  it('falls back to the live position when the snapshot has no entry', () => {
    const snapshot = new Map<number, [number, number]>();
    const live = new Map<number, [number, number]>([[1, [9, 9]]]);
    expect(resolveSegmentPosition(1, snapshot, live)).toEqual([9, 9]);
  });

  it('returns null when neither has an entry', () => {
    const snapshot = new Map<number, [number, number]>();
    const live = new Map<number, [number, number]>();
    expect(resolveSegmentPosition(1, snapshot, live)).toBeNull();
  });

  // #4162 — requireLive gate: a node absent from the rendered-marker map
  // (aged out / purged / hidden) must not anchor a dangling route segment,
  // even if the historical snapshot still holds a position for it.
  describe('requireLive (#4162)', () => {
    it('drops a node that has a snapshot but is absent from liveNodes', () => {
      const snapshot = new Map<number, [number, number]>([[1, [1, 1]]]);
      const live = new Map<number, [number, number]>();
      expect(resolveSegmentPosition(1, snapshot, live, true)).toBeNull();
    });

    it('still prefers the snapshot position when the node IS live', () => {
      const snapshot = new Map<number, [number, number]>([[1, [1, 1]]]);
      const live = new Map<number, [number, number]>([[1, [9, 9]]]);
      expect(resolveSegmentPosition(1, snapshot, live, true)).toEqual([1, 1]);
    });

    it('falls back to the live position for a live node with no snapshot', () => {
      const snapshot = new Map<number, [number, number]>();
      const live = new Map<number, [number, number]>([[1, [9, 9]]]);
      expect(resolveSegmentPosition(1, snapshot, live, true)).toEqual([9, 9]);
    });

    it('defaults (requireLive=false) to the legacy snapshot-then-live behavior', () => {
      const snapshot = new Map<number, [number, number]>([[1, [1, 1]]]);
      const live = new Map<number, [number, number]>();
      expect(resolveSegmentPosition(1, snapshot, live)).toEqual([1, 1]);
    });
  });
});

describe('hasReturnPath (#2051)', () => {
  it('is true when routeBack has hops, regardless of snrBack', () => {
    expect(hasReturnPath([123], null)).toBe(true);
    expect(hasReturnPath([123], '[]')).toBe(true);
    expect(hasReturnPath([123], [])).toBe(true);
  });

  it('is false for empty routeBack and no snrBack data (string form)', () => {
    expect(hasReturnPath([], null)).toBe(false);
    expect(hasReturnPath([], undefined)).toBe(false);
    expect(hasReturnPath([], '')).toBe(false);
    expect(hasReturnPath([], 'null')).toBe(false);
    expect(hasReturnPath([], '[]')).toBe(false);
  });

  it('is true for empty routeBack but non-empty snrBack (string form) — genuine direct RF hop', () => {
    expect(hasReturnPath([], '[32]')).toBe(true);
  });

  it('is false for empty routeBack and empty snrBack (array form)', () => {
    expect(hasReturnPath([], [])).toBe(false);
  });

  it('is true for empty routeBack but non-empty snrBack (array form)', () => {
    expect(hasReturnPath([], [32])).toBe(true);
  });
});

describe('decomposeTraceroute', () => {
  const resolvePosition = (nodeNum: number): [number, number] | null => {
    const table: Record<number, [number, number]> = {
      100: [10, 10],
      150: [15, 15],
      200: [20, 20],
    };
    return table[nodeNum] ?? null;
  };

  it('returns [] when route data is entirely absent (failed traceroute)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: '[]',
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('builds a direct forward-only segment when there is no return path', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([40]), // 10 dB
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      key: 'forward:100-200',
      from: [10, 10],
      to: [20, 20],
      leg: 'forward',
      avgSnr: 10,
      isMqtt: false,
    });
  });

  it('omits the fictitious return segment for empty routeBack + empty snrBack (#2051)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, 32]),
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    // Forward: 100->150, 150->200. No return segments at all.
    expect(segments.every((s) => s.leg === 'forward')).toBe(true);
    expect(segments.map((s) => s.key)).toEqual(['forward:100-150', 'forward:150-200']);
  });

  it('draws the return segment when snrBack has data despite empty routeBack (#2051)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([40]),
      snrBack: JSON.stringify([28]), // 7 dB
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    const ret = segments.find((s) => s.leg === 'return');
    expect(ret).toBeDefined();
    expect(ret).toMatchObject({
      key: 'return:200-100',
      from: [20, 20],
      to: [10, 10],
      avgSnr: 7,
      isMqtt: false,
    });
  });

  it('draws the return leg when routeBack is populated, walking it in reverse order', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([40, 32]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    const returnSegs = segments.filter((s) => s.leg === 'return');
    expect(returnSegs.map((s) => s.key)).toEqual(['return:200-150', 'return:150-100']);
    expect(returnSegs[0].avgSnr).toBe(9); // 36/4
    expect(returnSegs[1].avgSnr).toBe(6); // 24/4
  });

  it('maps the firmware unknown-SNR sentinel (raw -128) to snrUnknown=true without inventing IP/MQTT', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([-128]),
      snrBack: JSON.stringify([-128]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(2);
    for (const seg of segments) {
      expect(seg.avgSnr).toBeNull();
      expect(seg.snrUnknown).toBe(true);
      expect(seg.isMqtt).toBe(false);
    }
  });

  it('distinguishes a missing SNR sample from the explicit unknown-SNR sentinel', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: '[]', // no SNR sample at all for the one hop
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments).toHaveLength(1);
    expect(segments[0].avgSnr).toBeNull();
    expect(segments[0].snrUnknown).toBe(false);
    expect(segments[0].isMqtt).toBe(false);
  });

  it('/4-scales raw firmware SNR values', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([20]), // raw 20 -> 5 dB
      snrBack: '[]',
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments[0].avgSnr).toBe(5);
  });

  it('skips a hop segment when either endpoint fails to resolve a position', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 999, // not in the resolvePosition table
      route: '[]',
      routeBack: '[]',
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('carries the traceroute timestamp (or createdAt fallback) onto every segment', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrBack: '[1]',
      timestamp: 12345,
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.every((s) => s.timestamp === 12345)).toBe(true);

    const trFallback: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      createdAt: 999,
    };
    const segmentsFallback = decomposeTraceroute(trFallback, { resolvePosition });
    expect(segmentsFallback[0].timestamp).toBe(999);
  });

  it('builds return-only segments when the forward route is absent but a return path exists (review F1)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: JSON.stringify([150]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.every((s) => s.leg === 'return')).toBe(true);
    expect(segments.map((s) => s.key)).toEqual(['return:200-150', 'return:150-100']);
  });

  it('returns [] when both the forward route and the return path are absent', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: null,
      routeBack: null,
    };
    expect(decomposeTraceroute(tr, { resolvePosition })).toEqual([]);
  });

  it('never joins across a reserved/placeholder hop with no position', () => {
    const resolveWithExtra = (nodeNum: number): [number, number] | null =>
      nodeNum === 175 ? [17, 17] : resolvePosition(nodeNum);
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      // 4 hops: 100->150, 150->65535 (placeholder), 65535->175, 175->200
      route: JSON.stringify([150, 65535, 175]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, -128, 28, 20]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition: resolveWithExtra });
    // 150→65535 and 65535→175 cannot be placed, so they remain a visible gap.
    // Most importantly there is no fabricated 150→175 physical link.
    expect(segments.map((s) => s.key)).toEqual([
      'forward:100-150',
      'forward:175-200',
    ]);
    expect(segments.some((s) => s.fromNodeNum === 150 && s.toNodeNum === 175)).toBe(false);
  });

  it('inserts an anonymous firmware hop at a signal-weighted estimated position', () => {
    const resolveWithExtra = (nodeNum: number): [number, number] | null =>
      nodeNum === 175 ? [17, 17] : resolvePosition(nodeNum);
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150, 4294967295, 175]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, -128, 28, 20]),
    };
    const segments = decomposeTraceroute(tr, {
      resolvePosition: resolveWithExtra,
      estimateMissingHops: true,
      traceKey: 'trace-7',
    });

    expect(segments).toHaveLength(4);
    expect(segments.map((s) => [s.fromNodeNum, s.toNodeNum])).toEqual([
      [100, 150],
      [150, 4294967295],
      [4294967295, 175],
      [175, 200],
    ]);
    const intoUnknown = segments[1];
    const outOfUnknown = segments[2];
    expect(intoUnknown.toPositionEstimated).toBe(true);
    expect(outOfUnknown.fromPositionEstimated).toBe(true);
    expect(intoUnknown.to).toEqual(outOfUnknown.from);
    expect(intoUnknown.to[0]).toBeGreaterThan(15);
    expect(intoUnknown.to[0]).toBeLessThan(17);
    expect(intoUnknown.toHopKey).toContain('trace-7:forward:unknown:1');
    // Arrival SNRs remain attached to their original raw hops.
    expect(intoUnknown).toMatchObject({ avgSnr: null, snrUnknown: true, isMqtt: false });
    expect(outOfUnknown).toMatchObject({ avgSnr: 7, isMqtt: false });
  });

  it('estimates a known but unpositioned hop closer to the stronger-SNR anchor', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([160]),
      routeBack: '[]',
      // Strong first link, weak second link.
      snrTowards: JSON.stringify([40, -20]),
    };
    const segments = decomposeTraceroute(tr, {
      resolvePosition,
      estimateMissingHops: true,
      traceKey: 'known-missing',
    });

    expect(segments).toHaveLength(2);
    const estimated = segments[0].to;
    expect(estimated[0]).toBeGreaterThan(10);
    expect(estimated[0]).toBeLessThan(15);
    expect(segments[0].toPositionEstimated).toBe(true);
    expect(segments[1].fromPositionEstimated).toBe(true);
  });

  it('honors the estimation visibility gate and leaves a gap instead of a direct link', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([160]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, 20]),
    };
    const segments = decomposeTraceroute(tr, {
      resolvePosition,
      estimateMissingHops: true,
      canEstimateHop: () => false,
    });

    expect(segments).toEqual([]);
  });

  it('carries fromNodeNum/toNodeNum hop identity on every segment (review F5)', () => {
    const tr: TracerouteDecomposeInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([150]),
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([40, 32]),
      snrBack: JSON.stringify([36, 24]),
    };
    const segments = decomposeTraceroute(tr, { resolvePosition });
    expect(segments.map((s) => [s.fromNodeNum, s.toNodeNum])).toEqual([
      [100, 150],
      [150, 200],
      [200, 150],
      [150, 100],
    ]);
  });
});

describe('isValidRouteNode (single home, review F2)', () => {
  it.each([0, 1, 2, 3, 255, 65535, 4294967295])('rejects reserved/broadcast node %i', (n) => {
    expect(isValidRouteNode(n)).toBe(false);
  });

  it.each([4, 100, 65534, 4294967294])('accepts real node numbers %i', (n) => {
    expect(isValidRouteNode(n)).toBe(true);
  });
});

describe('isUnknownRouteNode', () => {
  it('recognizes only the firmware anonymous-hop placeholder', () => {
    expect(isUnknownRouteNode(4294967295)).toBe(true);
    expect(isUnknownRouteNode(65535)).toBe(false);
    expect(isUnknownRouteNode(100)).toBe(false);
  });
});

describe('buildLiveNodePositionMap (review F9)', () => {
  it('builds a nodeNum -> [lat,lng] map via the extractor', () => {
    const items = [
      { id: 1, lat: 10, lng: 20 },
      { id: 2, lat: -5, lng: 15 },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.get(1)).toEqual([10, 20]);
    expect(map.get(2)).toEqual([-5, 15]);
  });

  it('skips entries the extractor returns null for', () => {
    const items = [{ id: 1, lat: 10, lng: 20 }];
    const map = buildLiveNodePositionMap(items, () => null);
    expect(map.size).toBe(0);
  });

  it('skips non-numeric or missing coordinates', () => {
    const items: Array<{ id: number; lat: number | null | undefined; lng: number | null | undefined }> = [
      { id: 1, lat: undefined, lng: 20 },
      { id: 2, lat: null, lng: null },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.size).toBe(0);
  });

  it('keeps a legitimate single-axis-zero position (equator or prime meridian)', () => {
    const items = [
      { id: 1, lat: 0, lng: 20 },
      { id: 2, lat: 10, lng: 0 },
    ];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.get(1)).toEqual([0, 20]);
    expect(map.get(2)).toEqual([10, 0]);
  });

  it('drops the (0,0) Null Island placeholder', () => {
    const items = [{ id: 1, lat: 0, lng: 0 }];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.has(1)).toBe(false);
  });

  it('drops a near-(0,0) garbage default (2^15 value 0.0032768) (#02ecd5e0)', () => {
    const items = [{ id: 1, lat: 0.0032768, lng: 0.0032768 }];
    const map = buildLiveNodePositionMap(items, (i) => ({ nodeNum: i.id, lat: i.lat, lng: i.lng }));
    expect(map.has(1)).toBe(false);
  });
});
