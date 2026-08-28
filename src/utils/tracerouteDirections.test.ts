import { describe, expect, it } from 'vitest';
import type { TracerouteRenderSegment } from './tracerouteSegments.js';
import { annotateTracerouteDirections } from './tracerouteDirections.js';

function segment(
  key: string,
  fromNodeNum: number,
  toNodeNum: number,
  snr: number,
  timestamp: number,
): TracerouteRenderSegment {
  return {
    key,
    from: [43.7, 10.4],
    to: [43.8, 10.5],
    fromNodeNum,
    toNodeNum,
    leg: 'forward',
    avgSnr: snr,
    isMqtt: false,
    timestamp,
  };
}

describe('annotateTracerouteDirections', () => {
  it('keeps one-way evidence one-way', () => {
    const [result] = annotateTracerouteDirections([
      segment('a-b', 100, 200, 8, 1_000),
    ]);

    expect(result.directionSummaries).toEqual([
      expect.objectContaining({
        fromNodeNum: 100,
        toNodeNum: 200,
        usageCount: 1,
      }),
    ]);
  });

  it('keeps opposite directions and their SNR samples separate', () => {
    const results = annotateTracerouteDirections([
      segment('a-b-1', 100, 200, 10, 1_000),
      segment('a-b-2', 100, 200, 12, 2_000),
      segment('b-a', 200, 100, -4, 3_000),
    ]);

    const summaries = results[0].directionSummaries ?? [];
    const forward = summaries.find((d) => d.fromNodeNum === 100 && d.toNodeNum === 200);
    const reverse = summaries.find((d) => d.fromNodeNum === 200 && d.toNodeNum === 100);

    expect(forward?.usageCount).toBe(2);
    expect(forward?.snrSamples.map((s) => s.snr)).toEqual([10, 12]);
    expect(reverse?.usageCount).toBe(1);
    expect(reverse?.snrSamples.map((s) => s.snr)).toEqual([-4]);
  });

  it('uses preserved occurrence observations when a consumer replaced pair-level SNR', () => {
    const raw = segment('a-b', 100, 200, 99, 9_000) as TracerouteRenderSegment & {
      observedSnr?: number | null;
      observedTimestamp?: number;
    };
    raw.observedSnr = 7;
    raw.observedTimestamp = 4_000;

    const [result] = annotateTracerouteDirections([raw]);
    expect(result.directionSummaries?.[0].snrSamples).toEqual([{ snr: 7, timestamp: 4_000 }]);
    expect(result.directionSummaries?.[0].latestTimestamp).toBe(4_000);
  });
});
