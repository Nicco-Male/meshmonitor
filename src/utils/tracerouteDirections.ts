import type { TracerouteRenderSegment } from './tracerouteSegments.js';

export interface TracerouteDirectionSummary {
  fromNodeNum: number;
  toNodeNum: number;
  usageCount: number;
  snrSamples: Array<{ snr: number; timestamp?: number }>;
  hasMqtt: boolean;
  latestTimestamp: number | null;
}

/**
 * Extra per-occurrence fields used by consumers that later replace a segment's
 * SNR/timestamp with a physical-pair aggregate. Keeping the original values
 * lets the shared map layer rebuild honest A->B and B->A statistics.
 */
export interface DirectionalTracerouteRenderSegment extends TracerouteRenderSegment {
  directionSummaries?: TracerouteDirectionSummary[];
  observedSnr?: number | null;
  observedTimestamp?: number;
  observedIsMqtt?: boolean;
}

function hopKey(nodeNum: number, explicitKey: string | undefined): string {
  return explicitKey ?? `node:${nodeNum}`;
}

/** Stable unordered identity for one physical traceroute hop. */
export function traceroutePhysicalPairKey(segment: TracerouteRenderSegment): string {
  const fromKey = hopKey(segment.fromNodeNum, segment.fromHopKey);
  const toKey = hopKey(segment.toNodeNum, segment.toHopKey);
  return fromKey < toKey ? `${fromKey}~${toKey}` : `${toKey}~${fromKey}`;
}

interface MutableDirectionSummary extends TracerouteDirectionSummary {
  directionKey: string;
}

/**
 * Annotate every rendered physical-hop occurrence with directional evidence.
 *
 * The input is expected to have already been filtered for the map's freshness
 * window. Therefore stale reverse evidence automatically disappears and a
 * previously bidirectional popup falls back to one-way without any special
 * expiry state.
 */
export function annotateTracerouteDirections(
  segments: TracerouteRenderSegment[],
): DirectionalTracerouteRenderSegment[] {
  const byPair = new Map<string, Map<string, MutableDirectionSummary>>();

  for (const rawSegment of segments) {
    const segment = rawSegment as DirectionalTracerouteRenderSegment;
    const pairKey = traceroutePhysicalPairKey(segment);
    const fromKey = hopKey(segment.fromNodeNum, segment.fromHopKey);
    const toKey = hopKey(segment.toNodeNum, segment.toHopKey);
    const directionKey = `${fromKey}>${toKey}`;

    let directions = byPair.get(pairKey);
    if (!directions) {
      directions = new Map<string, MutableDirectionSummary>();
      byPair.set(pairKey, directions);
    }

    let summary = directions.get(directionKey);
    if (!summary) {
      summary = {
        directionKey,
        fromNodeNum: segment.fromNodeNum,
        toNodeNum: segment.toNodeNum,
        usageCount: 0,
        snrSamples: [],
        hasMqtt: false,
        latestTimestamp: null,
      };
      directions.set(directionKey, summary);
    }

    summary.usageCount += 1;

    const snr = segment.observedSnr !== undefined ? segment.observedSnr : segment.avgSnr;
    const timestamp = segment.observedTimestamp ?? segment.timestamp;
    if (typeof snr === 'number' && Number.isFinite(snr)) {
      summary.snrSamples.push({
        snr,
        ...(typeof timestamp === 'number' && timestamp > 0 ? { timestamp } : {}),
      });
    }

    summary.hasMqtt ||= segment.observedIsMqtt ?? segment.isMqtt;
    if (
      typeof timestamp === 'number' &&
      timestamp > 0 &&
      (summary.latestTimestamp == null || timestamp > summary.latestTimestamp)
    ) {
      summary.latestTimestamp = timestamp;
    }
  }

  return segments.map((rawSegment) => {
    const segment = rawSegment as DirectionalTracerouteRenderSegment;
    const directions = byPair.get(traceroutePhysicalPairKey(segment));
    const directionSummaries = directions
      ? [...directions.values()].map(({ directionKey: _directionKey, ...summary }) => summary)
      : [];
    return { ...segment, directionSummaries };
  });
}
