/**
 * Shared traceroute decomposition utilities.
 *
 * Pure, React-free, leaflet-free — safe to import from anywhere (including
 * node-env tests) without pulling in `window`/`leaflet`. This is the SINGLE
 * home for four previously-duplicated behaviors:
 *   - #1862 — snapshot route positions (render historical traceroutes where
 *     nodes were at capture time, not where they are now).
 *   - #2051 — the empty-routeBack guard (don't draw a fictitious direct
 *     return line when the return path hasn't been recorded yet).
 *   - #2931 — the firmware unknown-SNR sentinel (MQTT-bridged / relay-role /
 *     decrypt-failure hops report a sentinel value, not a real SNR reading).
 *   - reserved/broadcast node-number handling (route arrays can contain a
 *     firmware placeholder for a relay-role hop that never exposed its
 *     identity; that hop must remain in the path, never be collapsed into a
 *     false direct link).
 *
 * `src/utils/mapHelpers.tsx` re-exports `UNKNOWN_SNR_SENTINEL`/`isUnknownSnr`
 * from here for backward compatibility with existing importers. This file
 * stays leaflet-free on purpose so `useTracerouteAnalysis.ts` and its tests
 * don't have to pull in `mapHelpers.tsx`'s leaflet import just for the
 * sentinel — don't add a leaflet/react-leaflet import here.
 */

// `nullIsland` is pure (no leaflet) — safe to import without breaking the
// leaflet-free guarantee above.
import { isBogusPosition } from './nullIsland.js';

// ---------------------------------------------------------------------------
// #2931 — unknown-hop SNR sentinel (canonical home, re-exported by mapHelpers)
// ---------------------------------------------------------------------------

/**
 * Scaled SNR sentinel for unknown hops.
 * Raw Meshtastic value is INT8_MIN (-128), divided by 4 = -32.
 * Firmware writes this in TraceRouteModule::insertUnknownHops when a hop's
 * SNR can't be filled in: MQTT-bridged leg, decrypt failure, relay-role node,
 * or pre-snr-array firmware. It is NOT specifically an MQTT marker — the
 * firmware uses it as a generic "unknown SNR" sentinel.
 */
export const UNKNOWN_SNR_SENTINEL = -32;

/** Returns true if the scaled SNR value is the firmware unknown-hop sentinel */
export const isUnknownSnr = (snr: number | undefined): boolean =>
  snr === UNKNOWN_SNR_SENTINEL;

/**
 * Average SNR across samples, ignoring the unknown-hop sentinel (#2931).
 * Returns `null` when there are no samples, or every sample was the
 * sentinel (no real RF data to average).
 */
export function averageNonSentinelSnr(samples: Array<{ snr: number }> | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  const rfSnrs = samples.filter((s) => !isUnknownSnr(s.snr)).map((s) => s.snr);
  if (rfSnrs.length === 0) return null;
  return rfSnrs.reduce((sum, v) => sum + v, 0) / rfSnrs.length;
}

// ---------------------------------------------------------------------------
// Reserved/broadcast node-number filtering
// ---------------------------------------------------------------------------

export const BROADCAST_ADDR = 4294967295;

/**
 * True for a real, renderable node number — false for firmware reserved or
 * placeholder values that can appear inside a route/routeBack hop array:
 *   - `<= 3` — reserved
 *   - `255` (0xff) — reserved
 *   - `65535` (0xffff) — invalid placeholder
 *   - `4294967295` (0xffffffff) — broadcast address
 * Single home for this predicate — hop-array filtering lives inside
 * `decomposeTraceroute`/`buildLegSegments` below.
 */
export function isValidRouteNode(nodeNum: number): boolean {
  if (nodeNum <= 3) return false;
  if (nodeNum === 255) return false;
  if (nodeNum === 65535) return false;
  if (nodeNum === BROADCAST_ADDR) return false;
  return true;
}

/**
 * True for the firmware's anonymous-hop placeholder. Unlike the other
 * reserved values, `0xffffffff` is meaningful route topology: it says a real
 * relay occurred but declined to expose its node number.
 */
export function isUnknownRouteNode(nodeNum: number): boolean {
  return nodeNum === BROADCAST_ADDR;
}

// ---------------------------------------------------------------------------
// #1862 — snapshot route positions
// ---------------------------------------------------------------------------

/**
 * Parse the `routePositions` JSON snapshot stored on a traceroute row.
 * Shape: `{ [nodeNum]: { lat, lng, alt? } }`.
 *
 * Presence is checked with `typeof === 'number'`, not a truthy check — a
 * node sitting exactly on the equator or prime meridian (`lat===0` or
 * `lng===0`) must still resolve to its stored snapshot position rather than
 * silently falling through to the live position.
 */
export function parseSnapshotRoutePositions(
  routePositions: string | null | undefined,
): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  if (!routePositions) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(routePositions);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const nodeNum = Number(key);
    if (!Number.isFinite(nodeNum)) continue;
    const entry = value as { lat?: unknown; lng?: unknown } | null;
    if (entry && typeof entry.lat === 'number' && typeof entry.lng === 'number') {
      // A snapshot captured while the node was at Null Island (a garbage GPS
      // default, e.g. the 2^15 value 0.0032768) must NOT anchor a route
      // segment there — skip it so resolveSegmentPosition falls through to the
      // live position (#02ecd5e0 "Jupiter Dad" routes shooting to 0,0).
      if (isBogusPosition(entry.lat, entry.lng)) continue;
      result.set(nodeNum, [entry.lat, entry.lng]);
    }
  }
  return result;
}

/**
 * Resolve a hop's render position, preferring the historical snapshot
 * (#1862) over the live position. Both maps are expected to already be
 * normalized to `[lat, lng]` tuples — normalizing a consumer's own live-node
 * shape (digest array, raw node map with `latitudeI/longitudeI` vs
 * `latitude/longitude`, etc.) is the caller's job, not this function's.
 *
 * `requireLive` (issue #4162): when true, a node absent from `liveNodes`
 * resolves to `null` (drop the hop) even if the snapshot still holds a
 * historical position for it. `liveNodes` is the caller's *rendered-marker*
 * position map, so this keeps route segments attached to actual markers —
 * a node that has aged out, been purged, or is hidden ("Hide from Map") has
 * no marker and must not anchor a dangling line. When the node IS live, the
 * #1862 snapshot-then-live preference is preserved. Route-segment overlays
 * pass `true`; the single-traceroute display leaves it `false` so it can show
 * every hop (including hidden/aged relays) of one specific traceroute.
 */
export function resolveSegmentPosition(
  nodeNum: number,
  snapshot: Map<number, [number, number]>,
  liveNodes: Map<number, [number, number]>,
  requireLive = false,
): [number, number] | null {
  if (requireLive && !liveNodes.has(nodeNum)) return null;
  return snapshot.get(nodeNum) ?? liveNodes.get(nodeNum) ?? null;
}

/**
 * Build a `nodeNum -> [lat, lng]` map from a consumer's live node list.
 * `extract` returns the node number and raw (possibly missing) coordinates
 * for one item, or `null` to skip it entirely.
 *
 * Validity rule: coordinates must both be numbers AND must not be at Null
 * Island — a coordinate within {@link isBogusPosition}'s radius of `(0, 0)` is an
 * uninitialized/garbage GPS default and is dropped, while a single axis at
 * exactly 0 (equator or prime meridian, with the other axis far from 0) is a
 * legitimate position and is kept. This uses the shared Null-Island radius
 * (not an exact `(0,0)` check) so garbage defaults like the 2^15 value
 * 0.0032768 don't anchor neighbor/route line endpoints at (0, 0).
 */
export function buildLiveNodePositionMap<T>(
  items: Iterable<T>,
  extract: (item: T) => { nodeNum: number; lat: number | null | undefined; lng: number | null | undefined } | null,
): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>();
  for (const item of items) {
    const entry = extract(item);
    if (!entry) continue;
    const { nodeNum, lat, lng } = entry;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (isBogusPosition(lat, lng)) continue;
    map.set(nodeNum, [lat, lng]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// #2051 — empty-routeBack guard
// ---------------------------------------------------------------------------

/**
 * True only when a return path genuinely exists — i.e. either `routeBack`
 * has intermediate hops, or `snrBack` carries actual data. When
 * MeshMonitor is connected to the traceroute's target node, it can observe
 * its own outgoing RESPONSE before relay nodes have populated `routeBack`;
 * naively building `[to, ...routeBack, from]` in that window draws a
 * fictitious direct return line. (Issues #1140, #3622, #2051.)
 *
 * `snrBack` accepts either the raw JSON string as stored on the traceroute
 * row (checked against `''`/`'null'`/`'[]'`) or an already-parsed array
 * (checked by length) — the two pre-existing per-consumer implementations
 * this replaces (Widget: string form; useTracerouteAnalysis: parsed-array
 * form) used one or the other, so this accepts both. Widened to also accept
 * `undefined` (not just `null`) since traceroute rows commonly type
 * `snrBack` as optional.
 */
export function hasReturnPath(
  routeBack: number[],
  snrBack: string | number[] | null | undefined,
): boolean {
  if (routeBack.length > 0) return true;
  if (snrBack == null) return false;
  if (typeof snrBack === 'string') {
    return snrBack !== '' && snrBack !== 'null' && snrBack !== '[]';
  }
  return snrBack.length > 0;
}

// ---------------------------------------------------------------------------
// Per-traceroute decomposition
// ---------------------------------------------------------------------------

export interface TracerouteRenderSegment {
  key: string;
  from: [number, number];              // lat,lng — already snapshot-resolved
  to: [number, number];
  /** Hop node numbers this segment connects, in traversal order (from -> to). */
  fromNodeNum: number;
  toNodeNum: number;
  /** Stable per-hop identities. Real nodes use `node:<nodeNum>`; anonymous
   *  firmware placeholders are scoped to the traceroute + leg + hop index so
   *  unrelated hidden relays are never aggregated together. */
  fromHopKey?: string;
  toHopKey?: string;
  /** True when the endpoint did not have a reported/snapshot position and was
   *  placed by signal-weighted interpolation between positioned route anchors. */
  fromPositionEstimated?: boolean;
  toPositionEstimated?: boolean;
  /** Zero-based hop index within this directional leg, plus total hop count. */
  hopIndex?: number;
  hopCount?: number;
  leg: 'forward' | 'return' | 'neutral';
  direction?: 'inbound' | 'outbound' | 'neutral'; // MapAnalysis relative-to-selection
  avgSnr: number | null;               // /4-scaled dB; null = no data
  isMqtt: boolean;                      // per-hop sentinel (#2931), NOT node.viaMqtt
  usageCount?: number;                  // weightByUsage
  occurrences?: number;                 // weightByOccurrence
  timestamp?: number;                   // temporal fade
  snrSamples?: { snr: number; timestamp?: number }[]; // popup/chart + array color/opacity
}

/**
 * Minimal traceroute row shape `decomposeTraceroute` needs. A structural
 * subset of `TracerouteDigest` (useTraceroutePaths.tsx) so callers can pass
 * their existing traceroute records without an adapter.
 */
export interface TracerouteDecomposeInput {
  fromNodeNum: number;
  toNodeNum: number;
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
  timestamp?: number;
  createdAt?: number;
}

export interface DecomposeTracerouteOptions {
  /** Resolve a hop's node number to a render position, or null if unknown
   *  (the segment touching that hop is skipped, matching all three
   *  pre-existing renderers' "only push a segment when both endpoints
   *  resolve" behavior). Typically `(n) => resolveSegmentPosition(n, snapshot, liveNodes)`. */
  resolvePosition: (nodeNum: number) => [number, number] | null;
  /**
   * Estimate unresolved intermediate hops between the nearest positioned
   * anchors. This never estimates a missing source/destination endpoint and
   * never joins across an unresolved hop.
   */
  estimateMissingHops?: boolean;
  /** Optional visibility/permission gate for position estimation. Anonymous
   *  firmware placeholders should normally return true. */
  canEstimateHop?: (nodeNum: number) => boolean;
  /** Caller-owned identity used to keep anonymous placeholders from different
   *  traceroute records distinct during cross-trace aggregation. */
  traceKey?: string;
}

/** `JSON.parse` a route/hop/SNR array, tolerating null/'null'/'' (all -> []).
 *  Deliberately does NOT filter node validity — this parses both node-number
 *  arrays (route/routeBack) and SNR-sample arrays (snrTowards/snrBack), and
 *  filtering only applies to the former. Node filtering happens in
 *  `buildLegSegments`, where it can stay index-aligned with the paired SNR
 *  sample instead of shifting it. */
function parseHopArray(json: string | null | undefined): number[] {
  if (!json || json === 'null' || json === '') return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)) : [];
  } catch {
    return [];
  }
}

/** True when `route` carries actual (possibly empty-array) route data, as
 *  opposed to being entirely absent/failed. */
function hasRouteData(route: string | null | undefined): boolean {
  return route != null && route !== 'null' && route !== '';
}

/** One raw hop paired with the SNR observed arriving at it, before any
 *  node-validity filtering — keeping the pairing lets a hop be dropped
 *  without shifting its neighbors' SNR samples out of alignment. */
interface HopEntry {
  nodeNum: number;
  /** Already-scaled by caller? No — raw firmware int (dB x4); undefined for
   *  the leg's start (nothing "arrives" there) or a missing array entry. */
  snr: number | undefined;
  position: [number, number] | null;
  positionEstimated: boolean;
  hopKey: string;
}

/**
 * Relative edge-length proxy derived from SNR. Higher SNR means a shorter
 * likely radio span. The unknown-SNR sentinel is deliberately neutral.
 */
function edgeLengthProxy(rawSnr: number | undefined): number {
  if (rawSnr === undefined) return 1;
  const snrDb = rawSnr / 4;
  if (!Number.isFinite(snrDb) || isUnknownSnr(snrDb)) return 1;
  // Free-space distance is proportional to 10^(-SNR/20). Clamp the input so a
  // single noisy sample cannot pin an estimated hop exactly onto an anchor.
  const clampedDb = Math.max(-20, Math.min(20, snrDb));
  return Math.pow(10, -clampedDb / 20);
}

/** Interpolate longitude across the antimeridian via the shorter arc. */
function interpolatePosition(
  from: [number, number],
  to: [number, number],
  fraction: number,
): [number, number] {
  const lat = from[0] + (to[0] - from[0]) * fraction;
  let lngDelta = to[1] - from[1];
  if (lngDelta > 180) lngDelta -= 360;
  if (lngDelta < -180) lngDelta += 360;
  let lng = from[1] + lngDelta * fraction;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return [lat, lng];
}

/**
 * Fill each contiguous run of unresolved *intermediate* hops when it is
 * bracketed by positioned route anchors. Edge SNRs determine the relative
 * spacing: stronger links are shorter, weaker links are longer. This is a
 * route-local fallback for immediate rendering; the server's persistent
 * multi-observation estimator remains the authoritative triangulation.
 */
function estimateBracketedHopPositions(
  hops: HopEntry[],
  canEstimateHop: (nodeNum: number) => boolean,
): void {
  let index = 1;
  while (index < hops.length - 1) {
    if (hops[index].position) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < hops.length - 1 && !hops[index].position) index += 1;
    const runEnd = index - 1;
    const leftIndex = runStart - 1;
    const rightIndex = index;
    const left = hops[leftIndex];
    const right = hops[rightIndex];

    if (
      !left.position ||
      !right.position ||
      !hops.slice(runStart, runEnd + 1).every((hop) => canEstimateHop(hop.nodeNum))
    ) {
      continue;
    }

    const edgeLengths: number[] = [];
    let totalLength = 0;
    for (let edge = leftIndex; edge < rightIndex; edge += 1) {
      const length = edgeLengthProxy(hops[edge + 1].snr);
      edgeLengths.push(length);
      totalLength += length;
    }
    if (!(totalLength > 0) || !Number.isFinite(totalLength)) continue;

    let travelled = 0;
    for (let hopIndex = runStart; hopIndex <= runEnd; hopIndex += 1) {
      travelled += edgeLengths[hopIndex - leftIndex - 1];
      hops[hopIndex].position = interpolatePosition(
        left.position,
        right.position,
        travelled / totalLength,
      );
      hops[hopIndex].positionEstimated = true;
    }
  }
}

function buildLegSegments(
  leg: 'forward' | 'return',
  startNum: number,
  intermediateHops: number[],
  endNum: number,
  snrRaw: number[],
  timestamp: number | undefined,
  opts: DecomposeTracerouteOptions,
): TracerouteRenderSegment[] {
  // Pair every raw hop (including the end endpoint) with its own arrival SNR
  // by index. Crucially, never filter/compress the topology here: removing an
  // anonymous or unpositioned relay would turn A→?→B into a false A→B link.
  const traceKey = opts.traceKey ?? 'trace';
  const hops: HopEntry[] = [
    {
      nodeNum: startNum,
      snr: undefined,
      position: opts.resolvePosition(startNum),
      positionEstimated: false,
      hopKey: `node:${startNum}`,
    },
    ...intermediateHops.map((nodeNum, idx): HopEntry => {
      const identityKnown = isValidRouteNode(nodeNum);
      return {
        nodeNum,
        snr: idx < snrRaw.length ? snrRaw[idx] : undefined,
        // Reserved placeholders must never accidentally resolve through a
        // globally-stored row keyed by their shared sentinel value.
        position: identityKnown ? opts.resolvePosition(nodeNum) : null,
        positionEstimated: false,
        hopKey: identityKnown
          ? `node:${nodeNum}`
          : `${traceKey}:${leg}:unknown:${idx}:${nodeNum}`,
      };
    }),
    {
      nodeNum: endNum,
      snr: intermediateHops.length < snrRaw.length ? snrRaw[intermediateHops.length] : undefined,
      position: opts.resolvePosition(endNum),
      positionEstimated: false,
      hopKey: `node:${endNum}`,
    },
  ];

  if (opts.estimateMissingHops) {
    estimateBracketedHopPositions(
      hops,
      opts.canEstimateHop ?? ((nodeNum) => isValidRouteNode(nodeNum) || isUnknownRouteNode(nodeNum)),
    );
  }

  const segments: TracerouteRenderSegment[] = [];
  for (let i = 0; i < hops.length - 1; i++) {
    const fromHop = hops[i];
    const toHop = hops[i + 1];
    const fromNum = fromHop.nodeNum;
    const toNum = toHop.nodeNum;
    const fromPos = fromHop.position;
    const toPos = toHop.position;
    if (!fromPos || !toPos) continue;

    // SNR arriving at the segment's `to` end is what firmware recorded for
    // this hop (see HopEntry above).
    const rawSnr = toHop.snr;
    const scaledSnr = rawSnr === undefined ? undefined : rawSnr / 4;
    const isMqtt = scaledSnr !== undefined && isUnknownSnr(scaledSnr);
    const avgSnr = scaledSnr === undefined || isMqtt ? null : scaledSnr;

    segments.push({
      key:
        isValidRouteNode(fromNum) && isValidRouteNode(toNum)
          ? `${leg}:${fromNum}-${toNum}`
          : `${leg}:${fromHop.hopKey}-${toHop.hopKey}`,
      from: fromPos,
      to: toPos,
      fromNodeNum: fromNum,
      toNodeNum: toNum,
      fromHopKey: fromHop.hopKey,
      toHopKey: toHop.hopKey,
      fromPositionEstimated: fromHop.positionEstimated,
      toPositionEstimated: toHop.positionEstimated,
      hopIndex: i,
      hopCount: hops.length - 1,
      leg,
      avgSnr,
      isMqtt,
      timestamp,
    });
  }
  return segments;
}

/**
 * Decompose one traceroute record into per-hop forward + return render
 * segments. Consumers (NodesTab base/selected, Widget, Dashboard) call this
 * once per traceroute then apply their own cross-traceroute aggregation
 * (dedup, usage counting, zoom-adaptive filtering — data-side) on top; this
 * function does NOT aggregate across multiple traceroute records.
 *
 * - Forward leg: `[fromNodeNum, ...route, toNodeNum]` with `snrTowards`,
 *   matching the existing convention shared by useTraceroutePaths/Widget/
 *   DashboardMap (NOT the `useTracerouteAnalysis` requester/responder
 *   convention, which is a separate, untouched data hook). Gated solely by
 *   `hasRouteData(traceroute.route)`.
 * - Return leg: only emitted when `hasReturnPath` is true (#2051); sequence
 *   `[toNodeNum, ...routeBack, fromNodeNum]` with `snrBack`. Gated
 *   independently of the forward leg — a traceroute with no forward `route`
 *   but a populated `routeBack`/`snrBack` still yields return segments (and
 *   vice versa); the two legs are not coupled to a single whole-traceroute
 *   guard.
 *
 * `key` embeds the leg + hop node numbers (`"forward:123-456"`).
 */
export function decomposeTraceroute(
  traceroute: TracerouteDecomposeInput,
  opts: DecomposeTracerouteOptions,
): TracerouteRenderSegment[] {
  const timestamp = traceroute.timestamp ?? traceroute.createdAt;
  const segments: TracerouteRenderSegment[] = [];

  if (hasRouteData(traceroute.route)) {
    const route = parseHopArray(traceroute.route);
    const snrTowards = parseHopArray(traceroute.snrTowards);
    segments.push(
      ...buildLegSegments(
        'forward',
        traceroute.fromNodeNum,
        route,
        traceroute.toNodeNum,
        snrTowards,
        timestamp,
        opts,
      ),
    );
  }

  const routeBack = parseHopArray(traceroute.routeBack);
  if (hasReturnPath(routeBack, traceroute.snrBack)) {
    const snrBack = parseHopArray(traceroute.snrBack);
    segments.push(
      ...buildLegSegments(
        'return',
        traceroute.toNodeNum,
        routeBack,
        traceroute.fromNodeNum,
        snrBack,
        timestamp,
        opts,
      ),
    );
  }

  return segments;
}
