/**
 * Hook for rendering traceroute paths on the map
 *
 * This hook encapsulates all the logic for:
 * - Computing and memoizing base traceroute path segments
 * - Computing selected node traceroute visualization
 * - Rendering Polyline elements with popups showing SNR stats and charts
 *
 * Migration Note: This hook replaces the traceroutePathsElements and
 * selectedNodeTraceroute useMemo blocks in App.tsx.
 */

import React, { useMemo } from 'react';
import { DraggablePopup } from '../components/DraggablePopup';
import { calculateDistance, formatDistance } from '../utils/distance';
import { getSegmentSnrOpacity, weightByUsage, tracerouteSegmentWeight, type SnrColorScale } from '../utils/mapHelpers';
import {
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  decomposeTraceroute,
  hasReturnPath,
  isUnknownSnr,
  isValidRouteNode,
  averageNonSentinelSnr,
  type TracerouteRenderSegment,
} from '../utils/tracerouteSegments';
import { TraceroutePathsLayer } from '../components/map/layers/TraceroutePathsLayer';
import RouteSegmentPopup from '../components/map/popups/RouteSegmentPopup';
import { darkOverlayColors } from '../config/overlayColors';
import { logger } from '../utils/logger';
import type { DistanceUnit } from '../contexts/SettingsContext';

/**
 * Minimal node data needed for traceroute rendering
 * Uses digest format to prevent unnecessary re-renders
 */
export interface NodePositionDigest {
  nodeNum: number;
  position?: {
    latitude: number;
    longitude: number;
  };
  user?: {
    longName?: string;
    shortName?: string;
    id?: string;
  };
  viaMqtt?: boolean;
}

/**
 * Traceroute data structure
 */
export interface TracerouteDigest {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId?: string;
  toNodeId?: string;
  route: string;
  routeBack: string;
  snrTowards?: string;
  snrBack?: string;
  routePositions?: string; // JSON: { [nodeNum]: { lat, lng, alt? } } - position snapshot at traceroute time
  timestamp?: number;
  createdAt?: number;
}

/**
 * Theme colors for path rendering
 */
export interface ThemeColors {
  mauve: string;
  red: string;
  blue: string;
  overlay0: string;
  // Overlay scheme colors (override theme CSS colors when set)
  tracerouteForward?: string;
  tracerouteReturn?: string;
  mqttSegment?: string;
  neighborLine?: string;
  snrColors?: SnrColorScale;
}

/**
 * Callbacks for interactive elements in popups
 */
export interface TracerouteCallbacks {
  onSelectNode: (nodeId: string, position: [number, number]) => void;
  onSelectRouteSegment: (nodeNum1: number, nodeNum2: number) => void;
}

/**
 * Hook parameters
 */
export interface UseTraceroutePathsParams {
  showPaths: boolean;
  showRoute: boolean;
  selectedNodeId: string | null;
  currentNodeId: string | null;
  nodesPositionDigest: NodePositionDigest[];
  traceroutesDigest: TracerouteDigest[];
  distanceUnit: DistanceUnit;
  maxNodeAgeHours: number;
  themeColors: ThemeColors;
  callbacks: TracerouteCallbacks;
  /** Optional set of visible node numbers - when provided, only show route segments where both endpoints are visible */
  visibleNodeNums?: Set<number>;
  /** Current map zoom level - controls detail filtering */
  mapZoom?: number;
}

/**
 * Hook return value
 */
export interface UseTraceroutePathsResult {
  /** Base traceroute path elements (all paths when showPaths is true) */
  traceroutePathsElements: React.ReactElement[] | null;
  /** Selected node traceroute elements (specific route when showRoute is true) */
  selectedNodeTraceroute: React.ReactElement[] | null;
  /** Set of node numbers involved in the selected traceroute (for filtering map markers) */
  tracerouteNodeNums: Set<number> | null;
  /** Bounding box of the selected traceroute for zoom-to-fit [[minLat, minLng], [maxLat, maxLng]] */
  tracerouteBounds: [[number, number], [number, number]] | null;
}

const BROADCAST_ADDR = 4294967295;

/** Maximum age for traceroute lines shown on the normal map overlay. */
export const TRACEROUTE_MAP_MAX_AGE_HOURS = 4;

/** Stable unordered identity for one physical hop. Anonymous relay placeholders
 * carry trace-scoped hop keys from `decomposeTraceroute`, so they never merge
 * with an unrelated hidden relay from another trace. */
function segmentPairKey(segment: TracerouteRenderSegment): string {
  const fromKey = segment.fromHopKey ?? `node:${segment.fromNodeNum}`;
  const toKey = segment.toHopKey ?? `node:${segment.toNodeNum}`;
  return fromKey < toKey ? `${fromKey}~${toKey}` : `${toKey}~${fromKey}`;
}

const SELECTED_HOP_COLORS = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#06b6d4',
  '#eab308',
  '#ec4899',
];

/**
 * Fallback SNR color scale for the (structurally optional) `ThemeColors.snrColors`
 * field. In practice App.tsx always supplies a real scheme-derived scale
 * (`schemeColors.snrColors`); this only guards the type-level `undefined`
 * case so the shared `TraceroutePathsLayer`'s required `snrColors` prop
 * always has a value.
 */
const FALLBACK_SNR_COLORS: SnrColorScale = darkOverlayColors.snrColors;

// `isValidRouteNode` (reserved/broadcast node-number filtering) is imported
// from `tracerouteSegments.ts` — that's the single home; see its doc comment.
// #1862 snapshot parsing + snapshot-then-live position resolution likewise go
// through the shared `parseSnapshotRoutePositions`/`resolveSegmentPosition`/
// `buildLiveNodePositionMap` utils.

/**
 * Hook for computing and rendering traceroute paths on the map
 */
export function useTraceroutePaths({
  showPaths,
  showRoute,
  selectedNodeId,
  currentNodeId,
  nodesPositionDigest,
  traceroutesDigest,
  distanceUnit,
  themeColors,
  callbacks,
  visibleNodeNums,
  mapZoom,
}: UseTraceroutePathsParams): UseTraceroutePathsResult {
  // Shared live-node position map for the #1862 snapshot-then-live fallback,
  // built via the shared `buildLiveNodePositionMap` (also fixes the
  // lat/lng===0 falsy-zero bug on the live side, not just the snapshot side).
  const liveNodePositions = useMemo(
    () =>
      buildLiveNodePositionMap(nodesPositionDigest, (n) => ({
        nodeNum: n.nodeNum,
        lat: n.position?.latitude,
        lng: n.position?.longitude,
      })),
    [nodesPositionDigest],
  );

  // Memoize base traceroute paths (showPaths) - doesn't depend on selectedNodeId
  // This prevents re-rendering markers when clicking to select a node
  const traceroutePathsElements = useMemo(() => {
    if (!showPaths) return null;

    // Calculate per-physical-hop traceroute usage and collect directional SNR
    // observations. Anonymous hops use trace-scoped identities, never the
    // shared 0xffffffff placeholder, so unrelated hidden relays cannot merge.
    const segmentTraceIds = new Map<string, Set<number>>();
    const segmentSNRs = new Map<string, Array<{ snr: number; timestamp: number }>>();
    const segmentHasMqtt = new Map<string, boolean>();
    const segmentLatestTimestamp = new Map<string, number>();
    const segmentsList: TracerouteRenderSegment[] = [];

    // The normal map overlay is intentionally short-lived: a traceroute may
    // stay visible for at most 4 hours if its capture-time geometry is still
    // valid. Movement invalidation is handled separately by
    // resolveSegmentPosition/hasTracerouteSnapshotMoved. Historical traces
    // remain available elsewhere; they just stop being presented as current
    // map links after this TTL.
    const cutoffTime = Date.now() - TRACEROUTE_MAP_MAX_AGE_HOURS * 60 * 60 * 1000;
    const recentTraceroutes = traceroutesDigest.filter(tr => {
      const timestamp = tr.timestamp || tr.createdAt || 0;
      return timestamp >= cutoffTime;
    });

    // Deduplicate: keep only the most recent traceroute per node pair
    const tracerouteMap = new Map<string, TracerouteDigest>();
    recentTraceroutes.forEach(tr => {
      // Create a bidirectional key (same for A→B and B→A)
      const key = [tr.fromNodeNum, tr.toNodeNum].sort().join('-');
      const existing = tracerouteMap.get(key);
      const timestamp = tr.timestamp || tr.createdAt || 0;
      const existingTimestamp = existing?.timestamp || existing?.createdAt || 0;

      // Keep the most recent traceroute for this node pair
      if (!existing || timestamp > existingTimestamp) {
        tracerouteMap.set(key, tr);
      }
    });

    // Convert back to array for processing
    const deduplicatedTraceroutes = Array.from(tracerouteMap.values());

    deduplicatedTraceroutes.forEach((tr, idx) => {
      const timestamp = tr.timestamp || tr.createdAt || Date.now();
      const snapshotPositions = parseSnapshotRoutePositions(tr.routePositions);
      const resolvePosition = (nodeNum: number): [number, number] | null =>
        resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);
      const canEstimateHop = (nodeNum: number): boolean =>
        !isValidRouteNode(nodeNum) || !visibleNodeNums || visibleNodeNums.has(nodeNum);

      const decomposed = decomposeTraceroute(
        tr,
        {
          resolvePosition,
          estimateMissingHops: true,
          canEstimateHop,
          traceKey: `nodes-${idx}-${timestamp}`,
        },
      );

      for (const segment of decomposed) {
        const aggregateKey = segmentPairKey(segment);
        let traceIds = segmentTraceIds.get(aggregateKey);
        if (!traceIds) {
          traceIds = new Set<number>();
          segmentTraceIds.set(aggregateKey, traceIds);
        }
        traceIds.add(idx);

        if (segment.avgSnr !== null && Number.isFinite(segment.avgSnr)) {
          const samples = segmentSNRs.get(aggregateKey) ?? [];
          samples.push({ snr: segment.avgSnr, timestamp });
          segmentSNRs.set(aggregateKey, samples);
        }
        if (segment.isMqtt) segmentHasMqtt.set(aggregateKey, true);
        const existingTimestamp = segmentLatestTimestamp.get(aggregateKey) ?? 0;
        if (timestamp > existingTimestamp) segmentLatestTimestamp.set(aggregateKey, timestamp);

        segmentsList.push({
          ...segment,
          key: `tr-${idx}-${segment.key}`,
        });
      }
    });

    // A real endpoint must pass the map filters. An anonymous placeholder has
    // no ordinary node marker/filter row; its explicit estimated-hop marker is
    // the endpoint, so it remains eligible.
    let filteredSegments = visibleNodeNums
      ? segmentsList.filter(segment => {
          const fromVisible =
            !isValidRouteNode(segment.fromNodeNum) || visibleNodeNums.has(segment.fromNodeNum);
          const toVisible =
            !isValidRouteNode(segment.toNodeNum) || visibleNodeNums.has(segment.toNodeNum);
          return fromVisible && toVisible;
        })
      : segmentsList;

    // Zoom-adaptive filtering: at low zoom levels, only show stronger segments
    if (mapZoom !== undefined && mapZoom < 8) {
      // Regional view: only show segments with good or medium SNR (filter out poor/unknown)
      filteredSegments = filteredSegments.filter(segment => {
        const segKey = segmentPairKey(segment);
        const snrData = segmentSNRs.get(segKey);
        if (!snrData || snrData.length === 0) return false; // Hide unknown segments at low zoom
        const rfSnrs = snrData.filter(d => !isUnknownSnr(d.snr)).map(d => d.snr);
        if (rfSnrs.length === 0) return false; // Hide pure MQTT at low zoom
        const avgSnr = rfSnrs.reduce((sum, val) => sum + val, 0) / rfSnrs.length;
        return avgSnr >= -10; // Only good + medium quality links
      });
    }

    // Build shared render segments, carrying each occurrence's hop node
    // numbers directly on the segment (`fromNodeNum`/`toNodeNum`) so the
    // popup/className below can read them straight off `seg` instead of a
    // side-table lookup.
    const renderSegments: TracerouteRenderSegment[] = filteredSegments.map(segment => {
      const segmentKey = segmentPairKey(segment);
      const usage = segmentTraceIds.get(segmentKey)?.size ?? 1;
      // A segment is MQTT/IP only when the firmware reported the unknown-SNR
      // sentinel for that specific hop (issue #2931). Don't infer from
      // `node.viaMqtt` — that flag tracks how the node's own NodeInfo last
      // reached us, not how its radio segments work; a single MQTT/UDP
      // bridge node would otherwise mark every adjacent segment as IP and
      // cascade the dashed style across an entire route that's actually
      // mostly radio.
      const isMqttSegment = segmentHasMqtt.get(segmentKey) === true;
      const snrSamples = segmentSNRs.get(segmentKey) || [];
      const avgSnr = averageNonSentinelSnr(snrSamples);
      const latestTimestamp = segmentLatestTimestamp.get(segmentKey);

      return {
        ...segment,
        // Aggregated bidirectionally across (possibly many) traceroutes —
        // not a single forward/return leg, so 'neutral' (curvature 0 either
        // way for this layer, per the consumer table).
        leg: 'neutral',
        avgSnr,
        isMqtt: isMqttSegment,
        usageCount: usage,
        timestamp: latestTimestamp,
        snrSamples,
      };
    });

    // O(1) node lookup by nodeNum for the popup render-prop below, built
    // once per memo recomputation instead of a linear `.find()` per segment.
    const nodeByNum = new Map<number, NodePositionDigest>();
    for (const n of nodesPositionDigest) nodeByNum.set(n.nodeNum, n);

    // Shared popup content — this surface supplies the existing interactive
    // node/route callbacks, while Dashboard uses the same component read-only.
    const renderBasePopup = (seg: TracerouteRenderSegment): React.ReactNode => {
      const nodeNum1 = seg.fromNodeNum;
      const nodeNum2 = seg.toNodeNum;
      const segmentKey = segmentPairKey(seg);
      const usage = segmentTraceIds.get(segmentKey)?.size ?? 1;
      const node1 = nodeByNum.get(nodeNum1);
      const node2 = nodeByNum.get(nodeNum2);
      const isMqttSegment = seg.isMqtt;
      const node1Name =
        nodeNum1 === BROADCAST_ADDR
          ? 'Unknown hop'
          : node1?.user?.longName || node1?.user?.shortName || `!${nodeNum1.toString(16)}`;
      const node2Name =
        nodeNum2 === BROADCAST_ADDR
          ? 'Unknown hop'
          : node2?.user?.longName || node2?.user?.shortName || `!${nodeNum2.toString(16)}`;

      const segmentDistanceKm = calculateDistance(
        seg.from[0],
        seg.from[1],
        seg.to[0],
        seg.to[1],
      );

      return (
        <RouteSegmentPopup
          segment={seg}
          fromName={node1Name}
          toName={node2Name}
          distanceKm={segmentDistanceKm}
          distanceUnit={distanceUnit}
          usageCount={usage}
          isMqtt={isMqttSegment}
          onFromNodeClick={
            node1?.user?.id
              ? () => {
                  const freshNode = nodesPositionDigest.find((node) => node.nodeNum === nodeNum1);
                  if (
                    freshNode?.user?.id &&
                    freshNode?.position?.latitude &&
                    freshNode?.position?.longitude
                  ) {
                    callbacks.onSelectNode(freshNode.user.id, [
                      freshNode.position.latitude,
                      freshNode.position.longitude,
                    ]);
                  }
                }
              : undefined
          }
          onToNodeClick={
            node2?.user?.id
              ? () => {
                  const freshNode = nodesPositionDigest.find((node) => node.nodeNum === nodeNum2);
                  if (
                    freshNode?.user?.id &&
                    freshNode?.position?.latitude &&
                    freshNode?.position?.longitude
                  ) {
                    callbacks.onSelectNode(freshNode.user.id, [
                      freshNode.position.latitude,
                      freshNode.position.longitude,
                    ]);
                  }
                }
              : undefined
          }
          onUsageClick={
            isValidRouteNode(nodeNum1) && isValidRouteNode(nodeNum2)
              ? () => callbacks.onSelectRouteSegment(nodeNum1, nodeNum2)
              : undefined
          }
        />
      );
    };

    const baseSegmentClassName = (seg: TracerouteRenderSegment): string =>
      `route-segment node-${seg.fromNodeNum} node-${seg.toNodeNum}`;

    return [
      <TraceroutePathsLayer
        key="base-traceroute-layer"
        segments={renderSegments}
        snrColors={themeColors.snrColors ?? FALLBACK_SNR_COLORS}
        colorMode="snr"
        mqttColor={themeColors.mqttSegment ?? themeColors.overlay0}
        curvature={0}
        weight={seg => weightByUsage(seg.usageCount ?? 1)}
        opacity={seg => getSegmentSnrOpacity(seg.snrSamples, seg.isMqtt)}
        dashMode="mqtt-unknown"
        temporalFade
        renderPopup={renderBasePopup}
        segmentClassName={baseSegmentClassName}
        showEstimatedHopMarkers
        estimatedHopName={(nodeNum) => {
          const node = nodeByNum.get(nodeNum);
          return node?.user?.longName || node?.user?.shortName || (
            isValidRouteNode(nodeNum)
              ? `!${nodeNum.toString(16).padStart(8, '0')}`
              : 'Unknown hop'
          );
        }}
      />,
    ];
  }, [showPaths, traceroutesDigest, nodesPositionDigest, distanceUnit, themeColors.snrColors, themeColors.mqttSegment, themeColors.overlay0, callbacks, visibleNodeNums, mapZoom, liveNodePositions]);

  // Separate memoization for selected node traceroute (showRoute)
  // This can change independently without re-rendering the base map markers
  const selectedNodeTraceroute = useMemo(() => {
    // Skip rendering traceroute if the selected node is the current/local node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    try {
      // Route arrays are stored exactly as Meshtastic provides them (no
      // backend reversal). `decomposeTraceroute` filters reserved/broadcast
      // placeholder node numbers out of the route internally, so the raw
      // JSON is passed straight through.
      //
      // #1862 — snapshot positions via the shared util.
      const snapshotPositions = parseSnapshotRoutePositions(selectedTrace.routePositions);
      const resolvePosition = (nodeNum: number): [number, number] | null =>
        resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);

      // #1862/#2051/#2931 — per-traceroute decomposition (shared util). The
      // forward and return legs are gated independently: `route` gates the
      // forward leg, `hasReturnPath` gates the return leg (#2051) — a
      // traceroute can render one leg without the other.
      const segments = decomposeTraceroute(
        {
          fromNodeNum: selectedTrace.fromNodeNum,
          toNodeNum: selectedTrace.toNodeNum,
          route: selectedTrace.route,
          routeBack: selectedTrace.routeBack,
          snrTowards: selectedTrace.snrTowards,
          snrBack: selectedTrace.snrBack,
          timestamp: selectedTrace.timestamp,
          createdAt: selectedTrace.createdAt,
        },
        {
          resolvePosition,
          estimateMissingHops: true,
          canEstimateHop: (nodeNum) =>
            !isValidRouteNode(nodeNum) || !visibleNodeNums || visibleNodeNums.has(nodeNum),
          traceKey: `selected-${selectedTrace.timestamp ?? selectedTrace.createdAt ?? 'latest'}`,
        }
      );

      if (segments.length === 0) return null;

      const fromNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.fromNodeNum);
      const toNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.toNodeNum);
      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
      const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

      const nameForNode = (num: number): string => {
        if (!isValidRouteNode(num)) return 'Unknown hop';
        const n = nodesPositionDigest.find(nd => nd.nodeNum === num);
        return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
      };

      // Assign one deterministic color to each physical hop in this selected
      // trace. The same A↔B link keeps its color on the return leg, while a
      // different return route receives its own colors.
      const hopColorByKey = new Map<string, string>();
      for (const segment of segments) {
        const key = segmentPairKey(segment);
        if (!hopColorByKey.has(key)) {
          hopColorByKey.set(
            key,
            SELECTED_HOP_COLORS[hopColorByKey.size % SELECTED_HOP_COLORS.length],
          );
        }
      }

      // Leg-level popup metadata (distance, path listing) — computed once per
      // leg and reused across all of that leg's per-hop popups, matching the
      // pre-existing behavior where these were leg-level constants reused
      // inside the per-hop render loop.
      const legDistanceKm = (leg: 'forward' | 'return'): number =>
        segments
          .filter(s => s.leg === leg)
          .reduce((sum, s) => sum + calculateDistance(s.from[0], s.from[1], s.to[0], s.to[1]), 0);

      const legPathLabel = (leg: 'forward' | 'return'): string => {
        const legSegments = segments.filter(s => s.leg === leg);
        if (legSegments.length === 0) return '';
        // Reconstruct the hop sequence directly from each segment's
        // fromNodeNum/toNodeNum (segments are in traversal order).
        const nums: number[] = [];
        legSegments.forEach((s, i) => {
          if (i === 0) nums.push(s.fromNodeNum);
          nums.push(s.toNodeNum);
        });
        return nums.map(nameForNode).join(' → ');
      };

      const forwardDistanceKm = legDistanceKm('forward');
      const backDistanceKm = legDistanceKm('return');
      const forwardPathLabel = legPathLabel('forward');
      const backPathLabel = legPathLabel('return');

      const renderSelectedPopup = (seg: TracerouteRenderSegment): React.ReactNode => {
        const isForward = seg.leg === 'forward';
        const legDistance = isForward ? forwardDistanceKm : backDistanceKm;
        return (
          <DraggablePopup>
            <div className="route-popup">
              <h4>{isForward ? 'Forward Path' : 'Return Path'}</h4>
              <div className="route-endpoints">
                {isForward ? (
                  <><strong>{fromName}</strong> → <strong>{toName}</strong></>
                ) : (
                  <><strong>{toName}</strong> → <strong>{fromName}</strong></>
                )}
              </div>
              <div className="route-usage">
                Path:{' '}{isForward ? forwardPathLabel : backPathLabel}
              </div>
              {typeof seg.hopIndex === 'number' && typeof seg.hopCount === 'number' && (
                <div className="route-usage">
                  Hop: <strong>{seg.hopIndex + 1} of {seg.hopCount}</strong>
                </div>
              )}
              {legDistance > 0 && (
                <div className="route-usage">
                  Distance: <strong>{formatDistance(legDistance, distanceUnit)}</strong>
                </div>
              )}
              {(seg.avgSnr !== null || seg.isMqtt) && (
                <div className="route-usage" style={{ marginTop: '8px', borderTop: '1px solid var(--ctp-surface0)', paddingTop: '4px' }}>
                  Segment SNR: <strong>{seg.avgSnr !== null ? `${seg.avgSnr.toFixed(1)} dB` : 'Unknown'}</strong>
                  {seg.isMqtt && ' (IP)'}
                </div>
              )}
            </div>
          </DraggablePopup>
        );
      };

      return [
        <TraceroutePathsLayer
          key="selected-traceroute-layer"
          segments={segments}
          snrColors={themeColors.snrColors ?? FALLBACK_SNR_COLORS}
          colorMode="custom"
          segmentColor={(segment) =>
            hopColorByKey.get(segmentPairKey(segment)) ?? themeColors.overlay0
          }
          curvature={0.2}
          weight={tracerouteSegmentWeight}
          opacity={0.9}
          dashMode="mqtt-unknown"
          showArrows
          renderPopup={renderSelectedPopup}
          showEstimatedHopMarkers
          estimatedHopName={nameForNode}
        />,
      ];
    } catch (error) {
      logger.error('Error rendering selected node traceroute:', error);
      return null;
    }
  }, [showRoute, selectedNodeId, traceroutesDigest, nodesPositionDigest, currentNodeId, distanceUnit, themeColors.overlay0, themeColors.snrColors, liveNodePositions, visibleNodeNums]);

  // Compute the set of node numbers involved in the selected traceroute.
  // Used for filtering map markers to only show nodes in the active
  // traceroute. Guards/semantics mirror the selectedNodeTraceroute memo
  // above: forward and return legs are gated independently (a return-only
  // traceroute — empty `route`, populated `routeBack`/`snrBack` — still
  // frames/filters its return-leg nodes, matching that it still renders
  // return segments), so the marker filter always covers exactly the nodes
  // whose segments the shared layer actually draws.
  const tracerouteNodeNums = useMemo(() => {
    // Only compute when showRoute is enabled and there's a selected node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    const hasForwardRoute =
      !!selectedTrace.route && selectedTrace.route !== 'null' && selectedTrace.route !== '';

    try {
      let rawRouteBack: unknown = [];
      if (selectedTrace.routeBack && selectedTrace.routeBack !== 'null' && selectedTrace.routeBack !== '') {
        rawRouteBack = JSON.parse(selectedTrace.routeBack);
      }
      const routeBack = (Array.isArray(rawRouteBack) ? rawRouteBack : []).filter(isValidRouteNode);
      const hasReturn = hasReturnPath(routeBack, selectedTrace.snrBack);

      // Neither leg has data — decomposeTraceroute would render nothing.
      if (!hasForwardRoute && !hasReturn) return null;

      const nodeNums = new Set<number>();
      nodeNums.add(selectedTrace.fromNodeNum);
      nodeNums.add(selectedTrace.toNodeNum);

      if (hasForwardRoute) {
        const rawRouteForward = JSON.parse(selectedTrace.route);
        const routeForward = (Array.isArray(rawRouteForward) ? rawRouteForward : []).filter(isValidRouteNode);
        routeForward.forEach((num: number) => nodeNums.add(num));
      }

      if (hasReturn) {
        routeBack.forEach((num: number) => nodeNums.add(num));
      }

      return nodeNums.size > 0 ? nodeNums : null;
    } catch (error) {
      logger.error('Error computing traceroute node numbers:', error);
      return null;
    }
  }, [showRoute, selectedNodeId, currentNodeId, traceroutesDigest]);

  // Compute bounding box of the selected traceroute for zoom-to-fit.
  // Position resolution goes through the shared snapshot-then-live utils
  // (typeof-based #1862 snapshot checks) — the same resolution the rendered
  // segments use — so zoom-to-fit frames exactly what is drawn.
  const tracerouteBounds = useMemo((): [[number, number], [number, number]] | null => {
    if (!tracerouteNodeNums || tracerouteNodeNums.size === 0) return null;

    // Parse snapshot positions from the selected traceroute (#1862, shared util)
    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );
    if (!selectedTrace) return null;

    // Zoom-to-fit only kicks in for a *complete* (both-leg) traceroute. This
    // intentionally does NOT reuse tracerouteNodeNums' Phase-3 (#4047)
    // independent-leg gate: that gate was a deliberate change so the marker
    // filter above still shows exactly the nodes a forward-only/return-only
    // route renders. But NodesTab's node-click handlers (`onOmsClick`,
    // `handleNodeClick`) fall back to `centerMapOnNode` precisely when a
    // traceroute isn't "complete" by this same both-legs test - if bounds
    // were emitted for a partial route too, `TracerouteBoundsController`
    // would fire `fitBounds` right after `centerMapOnNode`'s `setView`,
    // silently overriding the node-centering (#4047 regression: "zoom to
    // node doesn't work" for nodes whose latest traceroute is one-way).
    // Keeping this gate identical to NodesTab's `hasTraceroute` check (and to
    // the pre-Phase-3 gate here) keeps the two decision points in sync.
    const hasCompleteRoute =
      !!selectedTrace.route && selectedTrace.route !== 'null' && selectedTrace.route !== '' &&
      !!selectedTrace.routeBack && selectedTrace.routeBack !== 'null' && selectedTrace.routeBack !== '';
    if (!hasCompleteRoute) return null;

    const snapshotPositions = parseSnapshotRoutePositions(selectedTrace?.routePositions);

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let hasValidPositions = false;

    tracerouteNodeNums.forEach(nodeNum => {
      const pos = resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);
      if (pos) {
        hasValidPositions = true;
        minLat = Math.min(minLat, pos[0]);
        maxLat = Math.max(maxLat, pos[0]);
        minLng = Math.min(minLng, pos[1]);
        maxLng = Math.max(maxLng, pos[1]);
      }
    });

    if (!hasValidPositions) return null;

    // Add some padding to the bounds (approximately 10% on each side)
    const latPadding = (maxLat - minLat) * 0.1 || 0.01;
    const lngPadding = (maxLng - minLng) * 0.1 || 0.01;

    return [
      [minLat - latPadding, minLng - lngPadding],
      [maxLat + latPadding, maxLng + lngPadding]
    ];
  }, [tracerouteNodeNums, liveNodePositions, traceroutesDigest, selectedNodeId]);

  return {
    traceroutePathsElements,
    selectedNodeTraceroute,
    tracerouteNodeNums,
    tracerouteBounds,
  };
}
