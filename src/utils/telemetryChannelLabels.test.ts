import { describe, expect, it } from 'vitest';
import {
  buildPowerMetricLabelOverrides,
  getPowerChannelNumbers,
  parseTelemetryChannelLabels,
  telemetryChannelLabelKey,
} from './telemetryChannelLabels';

describe('telemetryChannelLabels', () => {
  it('builds collision-safe, case-normalized node keys', () => {
    expect(telemetryChannelLabelKey('source:a', '!ABCDEF12')).toBe(
      'source%3Aa:!abcdef12',
    );
  });

  it('normalizes stored channel labels and ignores invalid entries', () => {
    expect(
      parseTelemetryChannelLabels(
        JSON.stringify({
          'source-a:!node': {
            1: ' Solar panel ',
            3: 'Battery',
            9: 'Invalid channel',
            bad: 42,
          },
          broken: null,
        }),
      ),
    ).toEqual({
      'source-a:!node': {
        1: 'Solar panel',
        3: 'Battery',
      },
    });
    expect(parseTelemetryChannelLabels('{not-json')).toEqual({});
  });

  it('finds voltage/current channels and expands their display labels', () => {
    expect(
      getPowerChannelNumbers([
        'batteryLevel',
        'ch3Current',
        'ch1Voltage',
        'ch3Voltage',
      ]),
    ).toEqual([1, 3]);

    expect(
      buildPowerMetricLabelOverrides({
        1: 'Solar panel',
        3: 'Load',
      }),
    ).toEqual({
      ch1Voltage: 'Solar panel · Voltage',
      ch1Current: 'Solar panel · Current',
      ch3Voltage: 'Load · Voltage',
      ch3Current: 'Load · Current',
    });
  });
});
